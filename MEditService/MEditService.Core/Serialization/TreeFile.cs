namespace MEditService.Core.Serialization;

/// <summary>One file of a plugin's serialized tree, relative to the tree's own root — what the
/// whole-mod door writes and reads. Where the tree sits in a mod folder is the Source repository's
/// answer.</summary>
public sealed record TreeFile(string RelativePath, byte[] Content);
