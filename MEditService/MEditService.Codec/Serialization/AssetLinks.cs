using Mutagen.Bethesda.Plugins.Assets;

namespace MEditService.Codec.Serialization;

/// <summary>The path in the Data folder an asset link holds, as Mutagen places it under its asset type's folder.</summary>
internal static class AssetLinks
{
    /// <summary>Throws what Mutagen throws for a path its asset type cannot hold.</summary>
    internal static string DataPathOf(Type assetLinkType, string given)
    {
        var assetType = assetLinkType.GetInterfaces().Prepend(assetLinkType)
            .Single(candidate => candidate.IsGenericType && candidate.GetGenericTypeDefinition() == typeof(IAssetLinkGetter<>)).GenericTypeArguments[0];
        return Activator.CreateInstance(typeof(AssetLinkGetter<>).MakeGenericType(assetType), given) is IAssetLinkGetter link
            ? link.DataRelativePath.Path
            : throw new InvalidOperationException($"Mutagen holds no asset link of {assetType.Name}.");
    }
}
