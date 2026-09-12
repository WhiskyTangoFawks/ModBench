namespace MEditService.Core.Serialization;

/// <summary>One file of a plugin's serialized tree. <paramref name="RelativePath"/> is
/// forward-slash-shaped, against the root its holder names: the tree's own root, or the mod folder
/// the Source repository has placed the tree in.</summary>
public sealed record TreeFile(string RelativePath, byte[] Content);
