# rotation-updater

The `rotation-updater` facilitates automating the updating of slack on-call user
group assignment via VictorOps outgoing webhooks and an AWS lambda function.

## Initial setup

To get everything setup for the first time see the [initial setup instructions](docs/INITIAL_SETUP.md).

## Adding a team's rotation

If everything is already setup and you just want to add your team's rotation see the [adding a rotation instructions](docs/ADD_ROTATION.md).

## Overview

The following depicts how the VictorOps on-call update results in the corresponding Slack update.
<img width="814" alt="update-on-call-flow" src="https://user-images.githubusercontent.com/8941415/158213420-e738406e-48f3-47d2-949b-770311272ee1.png">
