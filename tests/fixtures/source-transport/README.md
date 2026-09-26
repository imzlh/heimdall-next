The certificate and private key in this directory are disposable localhost test
fixtures. They must never be used in a deployment. The certificate covers
`localhost` and `127.0.0.1` and expires in September 2046.

The transport tests trust this certificate only in a child process through
`DENO_CERT`; certificate verification remains enabled. Test execution needs no
external network, certificate authority, or certificate generation dependency.
