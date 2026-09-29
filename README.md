# pi-tiny-fork

This package was split and no longer contains a Pi extension:

- `monitor`, `monitor_stop`, and `pi-sub` are in [pi-tiny-monitor](https://github.com/spoj/pi-tiny-monitor), which continues this history.
- Context replay is in [pi-tiny-replay](https://github.com/spoj/pi-tiny-replay).

Replace `git:github.com/spoj/pi-tiny-fork` in Pi's package configuration with `git:github.com/spoj/pi-tiny-monitor` and `git:github.com/spoj/pi-tiny-replay`, then reload. Do not load `pi-tiny-fork` together with `pi-tiny-monitor`.
