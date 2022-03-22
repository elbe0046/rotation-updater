#!/bin/sh

set -e

aws lambda update-function-code --function-name rotation-updater-prod_useast1 --zip-file fileb://lambda.zip
