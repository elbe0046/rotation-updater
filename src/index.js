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
const TEAMS_TABLE = process.env.TEAMS_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
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
class User {
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
 * Represents a team which has both a VictorOps team name as well as an
 * associated Slack User Group ID.
 **/
class Team {
  /**
  * @param {string} victorOpsGroupId
  * @param {string} slackUserGroupId
  **/
  constructor(
      victorOpsGroupId,
      slackUserGroupId,
  ) {
    this.victorOpsGroupId = victorOpsGroupId;
    this.slackUserGroupId = slackUserGroupId;
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
  console.log(
      'Updating Slack User Group (' + slackUserGroup + ') to User (' +
    slackUser + ')',
  );
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

  const team = await getTeam(
      victorOpsGroupId,
  );
  if (team?.slackUserGroupId == null) {
    console.log('Team not found for victorOpsGroupId: ' + victorOpsGroupId);
    return null;
  }

  const user = await getUser(
      victorOpsUserId,
  );
  if (user?.slackUserId == null) {
    console.log('User not found for victorOpsUserId: ' + victorOpsUserId);
    return null;
  }

  const secret = await SecretsStore.getSecret(SLACK_TOKEN_SECRET_NAME, REGION);
  if (secret == null) {
    console.log('Failed to retrieve secret: ' + SLACK_TOKEN_SECRET_NAME);
    return null;
  }

  let resp = await updateSlackUserGroup(
      team.slackUserGroupId,
      user.slackUserId,
      secret,
  );

  resp = {
    body: JSON.stringify(resp ?? {}),
  };

  return resp;
}

/**
 * Stores the provided {Team} into the teams DynamoDb table.
 *
 * @param {object} event The event containing the {Team}.
 * @return {object} The response from DynamoDb.
 **/
async function handlePutTeam(
    event,
) {
  const team = new Team(
      event.victorOpsGroupId,
      event.slackUserGroupId,
  );

  let resp = await dynamoDbClient().put({
    TableName: TEAMS_TABLE,
    Item: team,
  });

  resp = {
    body: JSON.stringify(resp ?? {}),
  };

  return resp;
}

/**
 * Retrieves the {Team} from the teams DynamoDb table corresponding to the
 * provided VictorOps group ID.
 *
 * @param {string} victorOpsGroupId The VictorOps group ID.
 * @return {Team} The team.
 **/
async function getTeam(
    victorOpsGroupId,
) {
  const resp = await dynamoDbClient().get({
    TableName: TEAMS_TABLE,
    Key: {
      victorOpsGroupId,
    },
  });

  if (resp?.Item == null) {
    console.log('Team not found for victorOpsGroupId: ' + victorOpsGroupId);
    return null;
  }

  const team = new Team(
      resp.Item.victorOpsGroupId,
      resp.Item.slackUserGroupId,
  );

  return team;
}

/**
 * Retrieves the {Team} from the teams DynamoDb table corresponding to the
 * provided VictorOps group ID.
 *
 * @param {object} event The event containing the VictorOps group ID.
 * @return {object} The response containing the {Team} in its body.
 **/
async function handleGetTeam(
    event,
) {
  const victorOpsGroupId = event.victorOpsGroupId;
  let resp = await getTeam(victorOpsGroupId);

  resp = {
    body: JSON.stringify(resp ?? {}),
  };

  return resp;
}

/**
 * Deletes the associated {Team} from the teams DynamoDb table.
 *
 * @param {object} event The event containing the VictorOps group ID.
 * @return {object} The response from DynamoDb.
 **/
async function handleDeleteTeam(
    event,
) {
  const victorOpsGroupId = event.victorOpsGroupId;
  let resp = await dynamoDbClient().delete({
    TableName: TEAMS_TABLE,
    Key: {
      victorOpsGroupId,
    },
  });

  resp = {
    body: JSON.stringify(resp?.Item ?? {}),
  };

  return resp;
}

/**
 * Stores the provided {User} into the users DynamoDb table.
 *
 * @param {object} event The event containing the {User}.
 * @return {object} The response from DynamoDb.
 **/
async function handlePutUser(
    event,
) {
  const user = new User(
      event.victorOpsUserId,
      event.slackUserId,
  );

  let resp = await dynamoDbClient().put({
    TableName: USERS_TABLE,
    Item: user,
  });

  resp = {
    body: JSON.stringify(resp ?? {}),
  };

  return resp;
}

/**
 * Retrieves the {User} from the users DynamoDb table corresponding to the
 * provided VictorOps user ID.
 *
 * @param {string} victorOpsUserId The VictorOps user ID.
 * @return {User} The user.
 **/
async function getUser(
    victorOpsUserId,
) {
  const resp = await dynamoDbClient().get({
    TableName: USERS_TABLE,
    Key: {
      victorOpsUserId,
    },
  });

  if (resp?.Item == null) {
    console.log('User not found for victorOpsUserId: ' + victorOpsUserId);
    return null;
  }

  const user = new User(
      resp.Item.victorOpsUserId,
      resp.Item.slackUserId,
  );

  return user;
}

/**
 * Retrieves the {User} from the users DynamoDb table corresponding to the
 * provided VictorOps user ID.
 *
 * @param {object} event The event containing the VictorOps user ID.
 * @return {object} The response containing the {User} in its body.
 **/
async function handleGetUser(
    event,
) {
  const victorOpsUserId = event.victorOpsUserId;
  let resp = await getUser(victorOpsUserId);

  resp = {
    body: JSON.stringify(resp ?? {}),
  };

  return resp;
}

/**
 * Deletes the associated {User} from the users DynamoDb table.
 *
 * @param {object} event The event containing the VictorOps user ID.
 * @return {object} The response from DynamoDb.
 **/
async function handleDeleteUser(
    event,
) {
  const victorOpsUserId = event.victorOpsUserId;
  let resp = await dynamoDbClient().delete({
    TableName: USERS_TABLE,
    Key: {
      victorOpsUserId,
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
    case 'putTeam':
      resp = await handlePutTeam(event);
      break;
    case 'getTeam':
      resp = await handleGetTeam(event);
      break;
    case 'deleteTeam':
      resp = await handleDeleteTeam(event);
      break;
    case 'putUser':
      resp = await handlePutUser(event);
      break;
    case 'getUser':
      resp = await handleGetUser(event);
      break;
    case 'deleteUser':
      resp = await handleDeleteUser(event);
      break;
    default:
      console.log('Unrecognized operation: ' + op);
  }

  console.log('resp: ' + JSON.stringify(resp ?? {}));

  return resp;
};
