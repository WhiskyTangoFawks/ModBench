# A file's owner keeps its metadata

Every file in both data bands has one owner: the repository that reads and writes it ([ADR-0014](0014-modules-are-layered-and-reference-only-downward.md)). That owner keeps the file's metadata, its hash included, and every other box gets it from the owner as state. A reader that hashes what it reads builds a second record of a file it does not own, with its own key, staleness and store, and the two drift ([principles](../principles.md), Orthogonality). What vouches for a remembered hash is the file's content, by its stamp ([ADR-0003](0003-modbench-never-assumes-exclusive-ownership-of-a-file-used-by-another-program.md)).

## Consequences

- A downloaded file's hash and the hashes of its entries come from the Instance adapter, which owns the downloaded files, and reach mEdit's engine as state beside the installation file ([ADR-0013](0013-mod-management-hands-editing-the-load-order.md)). The engine reads a downloaded file's bytes to write a mod folder, never to know what it holds.
- A mod folder file's hash is its manifest line, which the Mod folder adapter writes and reads back by the line's stamp, as git's index trusts its own. Stage and status trust the same line.
- A plugin file's hash is the Plugin adapter's; a plugin source document's is the Source adapter's. The record index stamps what they answer.
- A game file's hash comes from the Instance adapter too. The instance knows which game it runs and where its folder is, so it supplies the game folder with the hash of each game file a mod file overrides, and mEdit reads the game folder to write, never to know.

## Alternatives rejected

- A hash cache of its own, shared by every reader, as Wabbajack's VFS is. A box with no file to own, keyed by path on one side and by hash on the other, that every reader must keep in step.
- The engine hashes what it reads. One process's memory of files two processes read, gone at every launch, and a copy of the owner's knowledge.
