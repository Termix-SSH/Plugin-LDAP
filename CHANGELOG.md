# Changelog

## 1.0.0

### Added

- Sign in against LDAP or Active Directory
- More than one directory, each with its own login button
- LDAPS for encrypted connections
- Make members of an admin group Termix admins

### Fixed

- LDAPS now checks the server certificate. A directory with a self-signed or private certificate needs its CA pasted in the provider, or the new skip check switch
