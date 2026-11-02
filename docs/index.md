# pulse-api documentation

pulse-api is the backend of pulse. It receives probe results, stores them in SQLite, computes check states and incidents, and serves them over REST. These pages are for people who host it and people who work on it.

- [Install](install.md): run it with Bun or the Docker image; Compose setups are in pulse-deploy.
- [Concepts](concepts.md): check states, the quorum and incident rules, locations and tokens, retention and maintenance windows.
- [Configuration](configuration.md): every environment variable, the `checks.json` and `tokens.json` schemas, and where the Compose variables are described.
- [REST API](rest-api.md): every endpoint with parameters, responses and `curl` examples.
- [Operation](operation.md): upgrades, backup and restore, retention, token rotation and logs.
- [Troubleshooting](troubleshooting.md): error messages from the code, with cause and action.
- [Development](development.md): run, test and lint the code, and how changes are made.

The other pulse repositories:

- [pulse-probe](https://github.com/lorenzh/pulse-probe/blob/main/docs/index.md) runs the checks and posts results to this API.
- [pulse-status](https://github.com/lorenzh/pulse-status/blob/main/docs/index.md) renders the public status page from this API.
- [pulse-notify](https://github.com/lorenzh/pulse-notify/blob/main/docs/index.md) sends incident notifications.
- [pulse-contract](https://github.com/lorenzh/pulse-contract/blob/main/docs/index.md) holds the shared types.
