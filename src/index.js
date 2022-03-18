import fetch from 'node-fetch';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocument,
} from '@aws-sdk/lib-dynamodb';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const REGION = process.env.AWS_REGION;
const ROTATIONS_TABLE = process.env.ROTATIONS_TABLE;
const SLACK_TOKEN_SECRET_NAME = process.env.SLACK_TOKEN_SECRET_NAME;

/**
 * @type {DynamoDBDocument}
 **/
let dbClient;

/**
 * @type {SecretsManagerClient}
 **/
let secretsClient;

/**
 * Represents a user that has both a VictorOps user ID as well as an associated
 * Slack user ID.
 **/
class Member {
  /**
   * @param {string} victorOpsUserId
   * @param {string} slackUserId
   **/
  constructor(
      victorOpsUserId,
      slackUserId,
  ) {
    this.victorOpsUserId = victorOpsUserId;
    this.slackUserId = slackUserId;
  }
}

/**
 * Represents a database record which contains the mappings between VictorOps &
 * Slack for:
 * - Teams / User Groups
 * - Users
 **/
class Record {
  /**
  * @param {string} victorOpsGroupId
  * @param {string} slackUserGroupId
  * @param {Member[]} members
  **/
  constructor(
      victorOpsGroupId,
      slackUserGroupId,
      members,
  ) {
    this.victorOpsGroupId = victorOpsGroupId;
    this.slackUserGroupId = slackUserGroupId;
    this.members = members;
  }

  /**
  * Returns the first Slack User ID for the user matching the provided
  * VictorOps User ID, if any.
  *
  * @param {string} victorOpsUserId
  * @param {Member[]} members
  * @return {string} The associated Slack User ID, if any.
  **/
  getSlackUserId(victorOpsUserId) {
    const member = this.members.find((m) =>
      m.victorOpsUserId === victorOpsUserId,
    );
    return member?.slackUserId;
  }
}

/**
 * Provides ops on the underlying {SecretsManagerClient}
 **/
class SecretsStore {
  /**
  * Returns the secret value for the provided name in the specified region, if
  * any.
  *
  * @param {string} secretName The name of the secret
  * @param {string} region The AWS region
  * @return {string} The secret value, if any.
  **/
  static async getSecret(secretName, region) {
    const cmd = new GetSecretValueCommand({
      SecretId: secretName,
    });
    const secretValue = await secretsManagerClient().send(cmd);
    return secretValue.SecretString;
  }
}

/**
 * Allows for database connection reuse across invocations.
 *
 * @return {DynamoDBDocument} The DynamoDb connection / document.
 */
function dynamoDbClient() {
  if (typeof dbClient === 'undefined') {
    const client = new DynamoDBClient({
      region: REGION,
    });
    const marshallOptions = {
      convertClassInstanceToMap: true,
    };
    dbClient = DynamoDBDocument.from(client, {
      marshallOptions,
    });
  }
  return dbClient;
}

/**
 * Allows for secrets manager client reuse across invocations.
 *
 * @return {SecretsManagerClient} The secrets manager client.
 */
function secretsManagerClient() {
  if (typeof secretsClient === 'undefined') {
    const config = {
      region: REGION,
    };
    secretsClient = new SecretsManagerClient(config);
  }
  return secretsClient;
}

/**
 * Attempts to update the Slack User Group membership to reflect the VictorOps
 * on-call notification.
 *
 * @param {string} slackUserGroup The Slack User Group to which to assign
 * membership.
 * @param {string} slackUser The Slack User to assign to the Slack User Group.
 * @param {string} botUserOAuthToken The Slack Bot User OAuth token to
 * authenticate with slack for updating user group.
 * @return {object} The response from Slack.
 **/
async function updateSlackUserGroup(
    slackUserGroup,
    slackUser,
    botUserOAuthToken,
) {
  const data = {
    // The encoded ID of the User Group to update.
    usergroup: slackUserGroup,
    // A comma separated string of encoded users IDs that represent the
    // entire list of users for the User Group.
    users: slackUser,
  };
  const resp = await fetch('https://slack.com/api/usergroups.users.update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf8',
      'Authorization': 'Bearer ' + botUserOAuthToken,
    },
    body: JSON.stringify(data),
  });
  if (!resp.ok) {
    console.log('Failed to update slack user group: ' + resp);
    return;
  }
  return await resp.json();
}

/**
 * Handles an on-call notification from VictorOps, updating Slack User Group
 * membership accordingly if there is a sufficient information for this
 * mapping.
 *
 * @param {object} event The event containing the VictorOps notification.
 * @return {object} The response from Slack.
 **/
async function handleUpdateOnCall(
    event,
) {
  const victorOpsGroupId = event.group;
  const victorOpsUserId = event.user;

  const record = await getRotation(
      victorOpsGroupId,
  );
  if (record == null) {
    console.log('Rotation not found for victorOpsGroupId: ' + victorOpsGroupId);
    return null;
  }

  const slackUser = record.getSlackUserId(victorOpsUserId);
  if (slackUser == null) {
    console.log(
        'Slack user ID not found for victorOpsUserId: ' + victorOpsUserId,
    );
    return null;
  }

  const secret = await SecretsStore.getSecret(SLACK_TOKEN_SECRET_NAME, REGION);
  if (secret == null) {
    console.log('Failed to retrieve secret: ' + SLACK_TOKEN_SECRET_NAME);
    return null;
  }

  let resp = await updateSlackUserGroup(
      record.slackUserGroupId,
      slackUser,
      secret,
  );

  resp = {
    body: JSON.stringify(resp ?? {}),
  };

  return resp;
}

/**
 * Stores the provided VictorOps / Slack mapping into the DynamoDb table.
 *
 * @param {object} event The event containing the VictorOps / Slack mapping.
 * @return {object} The response from DynamoDb.
 **/
async function handlePutRotation(
    event,
) {
  const record = new Record(
      event.victorOpsGroupId,
      event.slackUserGroupId,
      event.members.map((member) =>
        new Member(member.victorOpsUserId, member.slackUserId)),
  );

  let resp = await dynamoDbClient().put({
    TableName: ROTATIONS_TABLE,
    Item: record,
  });

  resp = {
    body: JSON.stringify(resp ?? {}),
  };

  return resp;
}

/**
 * Retrieves the VictorOps / Slack mapping from the DynamoDb table
 * corresponding to the provided VictorOps group ID.
 *
 * @param {string} victorOpsGroupId The VictorOps groupd ID.
 * @return {Record} The VictorOps / Slack mapping.
 **/
async function getRotation(
    victorOpsGroupId,
) {
  const resp = await dynamoDbClient().get({
    TableName: ROTATIONS_TABLE,
    Key: {
      victorOpsGroupId,
    },
  });

  if (resp?.Item == null) {
    console.log('Rotation not found for victorOpsGroupId: ' + victorOpsGroupId);
    return null;
  }

  const record = new Record(
      resp.Item.victorOpsGroupId,
      resp.Item.slackUserGroupId,
      resp.Item.members.map((member) =>
        new Member(member.victorOpsUserId, member.slackUserId)),
  );

  return record;
}

/**
 * Retrieves the VictorOps / Slack mapping from the DynamoDb table
 * corresponding to the provided VictorOps group ID.
 *
 * @param {object} event The event containing the VictorOps group ID.
 * @return {object} The response containing the mapping in its body.
 **/
async function handleGetRotation(
    event,
) {
  const victorOpsGroupId = event.victorOpsGroupId;
  let resp = await getRotation(victorOpsGroupId);

  resp = {
    body: JSON.stringify(resp ?? {}),
  };

  return resp;
}

/**
 * Deletes the associated VictorOps / Slack mapping from the DynamoDb table.
 *
 * @param {object} event The event containing the VictorOps group ID.
 * @return {object} The response from DynamoDb.
 **/
async function handleDeleteRotation(
    event,
) {
  const victorOpsGroupId = event.victorOpsGroupId;
  let resp = await dynamoDbClient().delete({
    TableName: ROTATIONS_TABLE,
    Key: {
      victorOpsGroupId,
    },
  });

  resp = {
    body: JSON.stringify(resp?.Item ?? {}),
  };

  return resp;
}

export const handler = async (event, context, callback) => {
  context.callbackWaitsForEmptyEventLoop = false;

  console.log('req: ' + JSON.stringify(event));
  const op = event.operation;
  let resp = {};
  switch (op) {
    case 'updateOnCall':
      resp = await handleUpdateOnCall(event);
      break;
    case 'putRotation':
      resp = await handlePutRotation(event);
      break;
    case 'getRotation':
      resp = await handleGetRotation(event);
      break;
    case 'deleteRotation':
      resp = await handleDeleteRotation(event);
      break;
    default:
      console.log('Unrecognized operation: ' + op);
  }

  console.log('resp: ' + JSON.stringify(resp ?? {}));

  return resp;
};
