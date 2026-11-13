# Public CS package feed

This repository contains **generated package artifacts only**. The source code
of the packages is kept in a private repository.

Feed URL:

```text
https://michije.github.io/cs-extensions/index.json
```

`index.json` and `pool/<sha256>` are produced by `csdk repo build` from the
private source. Do not edit them by hand; every file is content-addressed and
the CS server verifies the hashes from the index.
