using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A game file by its forward-slash path in the game folder, with its hash as the Instance adapter knows it
/// (ADR-0013), and the path of the folder's file it was looked up for, if any.</summary>
public sealed record GameFile(string Path, string Hash, string? PathInFolder = null);

/// <summary>Another game folder holding the same game, such as the Steam install, at <paramref name="Root"/>, with the game files a
/// mod's files may be, and the store depots it records as installed.</summary>
public sealed record GameFolderPlace(string Root, IReadOnlyList<GameFile> Files, IReadOnlyList<GameDepot>? Depots = null);

/// <summary>The game folder as the Instance adapter hands it. Elsewhere: the game's other places, tried in order when this one
/// lacks a mod's pinned bytes. Depots: those it records, when it is the store's install.</summary>
public sealed record GameFolder(
    string Name, string Root, IReadOnlyList<GameFile> Files, IReadOnlyList<GameFolderPlace>? Elsewhere = null, IReadOnlyList<GameDepot>? Depots = null)
{
    internal IEnumerable<GameFolder> Places() =>
        [this with { Elsewhere = null }, .. (Elsewhere ?? []).Select(place => new GameFolder(Name, place.Root, place.Files, Depots: place.Depots))];
}
