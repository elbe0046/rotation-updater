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

class Member {
  constructor(
      victorOpsUserId,
      slackUserId,
  ) {
    this.victorOpsUserId = victorOpsUserId;
    this.slackUserId = slackUserId;
  }
}

class Record {
  constructor(
      victorOpsGroupId,
      slackUserGroupId,
      members,
  ) {
    this.victorOpsGroupId = victorOpsGroupId;
    this.slackUserGroupId = slackUserGroupId;
    this.members = members;
  }

  getSlackUserId(victorOpsUserId) {
    let slackUserId = null;
    for (const member of this.members) {
      if (member.victorOpsUserId === victorOpsUserId) {
        slackUserId = member.slackUserId;
        break;
      }
    }

    return slackUserId;
  }
}

class SecretsStore {
  static async getSecret(secretName, region) {
    const config = {
      region: region,
    };
    const secretsManager = new SecretsManagerClient(config);
    const cmd = new GetSecretValueCommand({
      SecretId: secretName,
    });
    const secretValue = await secretsManager.send(cmd);
    return secretValue.SecretString;
  }
}

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
  return resp.json();
}

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
  const secret = await SecretsStore.getSecret(SLACK_TOKEN_SECRET_NAME, REGION);

  if (slackUser == null) {
    console.log(
        'Slack user ID not found for victorOpsUserId: ' + victorOpsUserId,
    );
    return null;
  } else if (secret == null) {
    console.log('Failed to retrieve secret: ' + SLACK_TOKEN_SECRET_NAME);
    return null;
  }

  let resp = await updateSlackUserGroup(
      record.slackUserGroupId,
      slackUser,
      secret,
  );

  resp = {
    body: JSON.stringify(resp),
  };

  return resp;
}

async function handlePutRotation(
    event,
) {
  const record = new Record(
      event.victorOpsGroupId,
      event.slackUserGroupId,
      event.members.map((member) =>
        new Member(member.victorOpsUserId, member.slackUserId)),
  );

  const marshallOptions = {
    convertClassInstanceToMap: true,
  };

  const dynamoClient = new DynamoDBClient({
    region: REGION,
  });
  const docClient = DynamoDBDocument.from(dynamoClient, {
    marshallOptions,
  });
  await docClient.put({
    TableName: ROTATIONS_TABLE,
    Item: record,
  });

  return {};
}

async function getRotation(
    victorOpsGroupId,
) {
  const dynamoClient = new DynamoDBClient({
    region: REGION,
  });
  const docClient = DynamoDBDocument.from(dynamoClient);
  const resp = await docClient.get({
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

async function handleGetRotation(
    event,
) {
  const victorOpsGroupId = event.victorOpsGroupId;
  let resp = await getRotation(victorOpsGroupId);

  resp = {
    body: JSON.stringify(resp?.Item ?? {}),
  };

  return resp;
}

async function handleDeleteRotation(
    event,
) {
  const victorOpsGroupId = event.victorOpsGroupId;
  const dynamoClient = new DynamoDBClient({
    region: REGION,
  });
  const docClient = DynamoDBDocument.from(dynamoClient);
  let resp = await docClient.delete({
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

export const handler = async (event) => {
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
