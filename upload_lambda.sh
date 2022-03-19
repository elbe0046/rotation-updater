#!/bin/sh

set -e

aws lambda update-function-code --function-name rotation-updater --zip-file fileb://lambda.zip
