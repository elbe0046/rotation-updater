When creating any of the AWS resources listed here make sure to check for any
naming collisions and update accordingly.

Splunk On-Call & VictorOps are used somewhat interchangeably throughout, but
often falling back on VictorOps.

See [setup](../setup) for all of the files referenced as `file://` throughout.

## Requirements

- AWS CLI

## Creating the Slack app

From https://api.slack.com/apps/ select `Create New App` > `From scratch`.

Under `Name app & choose workspace`:
- `App Name`: `rotation-updater`
- `Workspace`: your workspace

Now you should be on the new app's page. On the left under `Features` select
`OAuth & Permissions`. Under `Scopes` > `Bot Token Scopes` select `Add an OAuth
Scope`.

Add the following scopes:
- `usergroups:read`
- `usergroups:write`

Now under `OAuth Tokens for Your Workspace` select `Install to Workspace` (`Allow`).

There should now be a Slack Bot OAuth Token under `OAuth Tokens for Your
Workspace` > `Bot User OAuth Token` which we will store as a secret in AWS
Secrets Manager.

## Storing Slack Bot OAuth Token in Secrets Manager

Create the secret as follows, where:
- the secret name that does not collide with existing secrets
- `rotation-updater-slack-bot-user-token` is the token created earlier
```sh
aws secretsmanager create-secret \
    --name RotationUpdaterSlackBotUserOauthToken \
    --description "rotation-updater Slack Bot User OAuth Token" \
    --secret-string "{slack-bot-user-oauth-token}"
```

Get the secret ARN (`slack-bot-user-oauth-token-arn`)
```sh
aws secretsmanager describe-secret --secret-id RotationUpdaterSlackBotUserOauthToken --query 'ARN' --output text
```

## DynamoDB table

We'll need a table in which to store our mappings between Splunk On-Call and
Slack rotations information.
```sh
aws dynamodb create-table --cli-input-json file://rotations-table-definition.json
```

Get the table ARN (`table-arn`)
```sh
aws dynamodb describe-table --table-name rotation-updater_rotations --query 'Table.TableArn' --output text
```

## Log group

For observability purposes we'll want access to our lambda's logs.
```sh
aws logs create-log-group --log-group-name /aws/lambda/rotation-updater-prod_useast1
```

Get the log group ARN (`log-group-arn`)
```sh
aws logs describe-log-groups --log-group-name /aws/lambda/rotation-updater-prod_useast1 --query 'logGroups[0].arn' --output text
```

## Lambda policy & role

The policy we assign to the lambda will need to be able to:
- Execute the lambda
- Obtain secrets from Secrets Manager
- Execute CRUD ops against the DynamoDb table
- Have logging capabilities

Fill in the ARNs from above into `lambda-policy.json`.

Create the resource policy.
```sh
aws iam create-policy --policy-name rotation-updater_policy --policy-document file://lambda-policy.json
```

Get the resource policy ARN (`resource-policy-arn`)
```sh
aws iam list-policies --query 'Policies[?PolicyName==`rotation-updater_policy`].Arn' --output text
```

Create the role
```sh
aws iam create-role --role-name app-rotation-updater --assume-role-policy-document file://assume-role-policy.json
```

Attach the resource policy
```sh
aws iam attach-role-policy --role-name app-rotation-updater --policy-arn  {resource-policy-arn}
```

Get the role ARN (`role-arn`)
```sh
aws iam list-roles --query 'Roles[?RoleName==`app-rotation-updater`].Arn' --output text
```

## Creating the lambda

Prep the zip.
```sh
npm run zip
```

Create the lambda
```sh
aws lambda create-function --function-name rotation-updater-prod_useast1 --zip-file fileb://path/to/lambda.zip --handler index.handler --runtime nodejs14.x --role {role-arn} --environment '{"Variables": {"ROTATIONS_TABLE": "rotation-updater_rotations", "SLACK_TOKEN_SECRET_NAME": "RotationUpdaterSlackBotUserOauthToken"}}'
```

Get the lambda ARN
```sh
aws lambda get-function --function-name rotation-updater-prod_useast1 --query 'Configuration.FunctionArn' --output text
```

## API Gateway REST API

Create the REST API
```sh
aws apigateway create-rest-api --name rotation-updater --api-key-source HEADER --endpoint-configuration='{"types":["REGIONAL"]}'
```

Get the REST API ID (`rest-api-id`)
```sh
aws apigateway get-rest-apis --query 'items[?name==`rotation-updater`].id' --output text
```

Get root resource ID (`root-resource-id`)
```sh
aws apigateway get-resources --rest-api-id {rest-api-id} --query 'items[?path==`/`].id' --output text
```

Create a resource
```sh
aws apigateway create-resource --rest-api-id {rest-api-id} --parent-id {root-resource-id} --path-part rotationupdater
```

Get resource ID (`resource-id`)
```sh
aws apigateway get-resources --rest-api-id {rest-api-id} --query 'items[?path==`/rotationupdater`].id' --output text
```

Create a method
```sh
aws apigateway put-method --rest-api-id {rest-api-id} --resource-id {resource-id} --http-method POST --authorization-type "NONE" --api-key-required
```

Create an integration
```sh
aws apigateway put-integration --rest-api-id {rest-api-id} --resource-id {resource-id} --http-method POST --integration-http-method POST --type AWS --uri arn:aws:apigateway:{region}:lambda:path/2015-03-31/functions/{lambda-arn}/invocations
```

Create the method response
```sh
aws apigateway put-method-response --rest-api-id {rest-api-id} --resource-id {resource-id} --http-method POST --status-code 200
```

Create the integration response
```sh
aws apigateway put-integration-response --rest-api-id {rest-api-id} --resource-id {resource-id} --http-method POST --status-code 200
```

Create the deployment & stage
```sh
aws apigateway create-deployment --rest-api-id {rest-api-id} --stage-name prod
```

Create the usage plan
```sh
aws apigateway create-usage-plan --name rotation-updater-usage-plan --api-stages '[{"apiId":"{rest-api-id}","stage":"prod"}]'
```

Get the usage plan ID (`usage-plan-id`)
```sh
aws apigateway get-usage-plans --query 'items[?name==`rotation-updater-usage-plan`].id' --output text
```

Create the API key
```sh
aws apigateway create-api-key --name rotation-updater-api-key --enabled
```

Get the API key ID (`api-key-id`)
```sh
aws apigateway get-api-keys --query 'items[?name==`rotation-updater-api-key`].id' --output text
```

Associate the API key with the usage plan
```sh
aws apigateway create-usage-plan-key --usage-plan-id {usage-plan-id} --key-id {api-key-id} --key-type "API_KEY"
```

Give API gateway permissions to invoke our lambda function
```sh
aws lambda add-permission --function-name rotation-updater-prod_useast1 --statement-id apigateway --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:{account-id}:{rest-api-id}/*/POST/rotationupdater"
```

## VictorOps outgoing webhook

Requires role of `Alert Admin` or higher, as well as the organization having enterprise access for outgoing webhooks.

In VictorOps, > `Integrations` > `Outgoing Webhooks` > `Add Webhook`:
- Events: `On-Call`
- Method: POST
- Content-type: application/json
- Add customer header: `x-api-key`, `{api-key}`
- To `https://{rest-api-id}.execute-api.us-east-1.amazonaws.com/prod/rotationupdater`
- Payload:
```json
{
  "operation": "updateOnCall",
  "group": "${{ONCALL.GROUP_ID}}",
  "user": "${{ONCALL.USER_ID}}",
  "team_name":"${{ONCALL.TEAM_NAME}}"
}
```
