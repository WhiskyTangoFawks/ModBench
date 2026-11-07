export const NEXUS_GUIDE = `Nexus works like a package registry, with a public API and a website that you cannot read.

- Nexus's GraphQL endpoint, https://api.nexusmods.com/v2/graphql, needs no key. It answers:
  - a mod search by name
  - a mod's requirements
  - a mod's files, with their IDs and changelogs
  - an MD5 lookup, which identifies a downloaded file by its hash
- A fetch of a nexusmods.com page is refused with a Cloudflare challenge. Use the API.
- downloaded_file_download downloads a file under the user's login. You never log in, and you never hold the user's API key.
- Downloading straight from the API, without the website, needs the user's Premium account.`;
