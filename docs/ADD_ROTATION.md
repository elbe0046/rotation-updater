## Adding a rotation

These instructions are for if the initial `rotation-updater` scaffolding has
already been established and you're simply looking to add your team's rotation
to it.

For this you'll need to determine:
- Your VictorOps rotation ID
- Your Slack User Group ID
- Each rotation member's VictorOps ID
- Each rotation member's Slack User ID

You'll also need to get the `rotation-updater`'s API key from AWS apigateway, as well as the REST API ID.

#### API Key

```sh
API_KEY_ID=$(aws apigateway get-api-keys --query 'items[?name==`rotation-updater-api-key`].id' --output text)

aws apigateway get-api-key --api-key $API_KEY_ID --include-value --query 'value' --output text
```

#### VictorOps rotation ID

In VictorOps go to your team's page. Get the group ID from the URL:
https://portal.victorops.com/dash/{org}#/team/{victor-ops-group-id}/rotations

#### Slack User ID

Sign into slack and navigate to https://app.slack.com/client > `People & user groups` > `Members`

Search for & select the desired user, `More` > `Copy Member ID`

#### VictorOps member ID

In VictorOps go to `Users`, search for the given user, then the value is in the `User Name` column.

#### Slack User Group ID

Sign into slack and navigate to https://app.slack.com/client > `People & user groups` > `User groups`

Search for & select the desired user group, get the user group ID from the URL:
https://app.slack.com/client/{_}/browse-user-groups/user_groups/{slack-user-group-id}

#### Add the mapping to the `rotation-updater` DynamoDb table

Fill out the above information into this template and save to a `put-rotation.json`:
```json
{
  "operation": "putRotation",
  "victorOpsGroupId": "{victor-ops-group-id}",
  "slackUserGroupId": "{slack-user-group-id}",
  "members": [
    {
      "victorOpsUserId": "{member1-victor-ops-user-id}",
      "slackUserId": "{member1-slack-user-id}"
    },
    {
      "victorOpsUserId": "{memberN-victor-ops-user-id}",
      "slackUserId": "{memberN-slack-user-id}"
    }
  ]
}
```

Now send the request to the lambda
```sh
API_KEY={API-key-from-API-gateway}
REQ=$(jq -c < put-rotation.json)
curl -X POST https://{rest-api-id}.execute-api.us-east-1.amazonaws.com/prod/rotationupdater \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d "$REQ"
```
