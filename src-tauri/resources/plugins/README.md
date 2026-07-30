# Bundled runtime plugin packages

Release CI places vendor-signed `.lnplugin` archives here (e.g.
`com.langnext.google-translate-web-1.0.0.lnplugin`) after the offline vendor
signing step. On first startup the app imports any archive present here into the
immutable plugin store and sets it as the default for new instances of its plugin
without migrating existing instances.

Local development does not ship a signed archive; the bootstrap is a no-op when
no archive is present. Never commit a private signing key to this directory.
