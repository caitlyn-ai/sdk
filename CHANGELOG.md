# [0.8.0](https://git.customd.com/custom-d/caitlyn/sdk/compare/v0.7.0...v0.8.0) (2026-11-15)


### Features

* the SDKs call every operation the v3 server implements, and deliver stream.reset ([156ad34](https://git.customd.com/custom-d/caitlyn/sdk/commit/156ad341901ff7014f92e09ce5638fd0dd510764))


### BREAKING CHANGES

* the SDKs call every operation the v3 server implements, and deliver stream.reset

# [0.7.0](https://git.customd.com/custom-d/caitlyn/sdk/compare/v0.6.0...v0.7.0) (2026-11-13)


### Bug Fixes

* **typescript:** CaitlynError declares the fields every Caitlyn error carries ([29ab90e](https://git.customd.com/custom-d/caitlyn/sdk/commit/29ab90e661817f175b20c207d11c75b5cc423b0d))


### Features

* **auth:** one refresh per refresh token, across clients sharing a store; a workspace URL is its hostname ([11a4464](https://git.customd.com/custom-d/caitlyn/sdk/commit/11a44640cd999e18071737bca90796edac5a377f))


### BREAKING CHANGES

* **auth:** one refresh per refresh token, across clients sharing a store; a workspace URL is its hostname

# [0.6.0](https://git.customd.com/custom-d/caitlyn/sdk/compare/v0.5.0...v0.6.0) (2026-11-13)


### Bug Fixes

* **python:** ValidationError.errors is a list of FieldError models ([173e08a](https://git.customd.com/custom-d/caitlyn/sdk/commit/173e08ad9d3f0b932a111d127cc4d54a780890dc))


### BREAKING CHANGES

* **python:** ValidationError.errors is a list of FieldError models

# [0.5.0](https://git.customd.com/custom-d/caitlyn/sdk/compare/v0.4.0...v0.5.0) (2026-11-13)


### Features

* **typescript:** the Node build sends requests with Node's built-in fetch ([d7153f2](https://git.customd.com/custom-d/caitlyn/sdk/commit/d7153f216320ce180e22eb60b7b9abb33fd1bfb7))


### BREAKING CHANGES

* **typescript:** the Node build sends requests with Node's built-in fetch

# [0.4.0](https://git.customd.com/custom-d/caitlyn/sdk/compare/v0.3.0...v0.4.0) (2026-11-13)


### Features

* **retry:** a client-side retry budget in every SDK ([d8b7bad](https://git.customd.com/custom-d/caitlyn/sdk/commit/d8b7bad3f22784ef4fb2997bbecd828defc1d0d1))

# [0.3.0](https://git.customd.com/custom-d/caitlyn/sdk/compare/v0.2.0...v0.3.0) (2026-11-12)


### Features

* **typescript:** every build runs on sdk-core's own runtime, without AWS retries, event streams or endpoint rules ([4a3075a](https://git.customd.com/custom-d/caitlyn/sdk/commit/4a3075aa4a2986aa38d92edcf0b68a2fbf747f83))
