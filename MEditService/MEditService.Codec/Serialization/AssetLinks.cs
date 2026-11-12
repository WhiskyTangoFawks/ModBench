using System.Reflection;
using Mutagen.Bethesda.Plugins.Assets;
using Mutagen.Bethesda.Plugins.Exceptions;

namespace MEditService.Codec.Serialization;

/// <summary>The path in the Data folder an asset link holds, or why its asset type cannot hold the path.</summary>
internal readonly record struct AssetLinkPath(string? DataPath, string? Refusal);

/// <summary>Mutagen places a path under its asset type's folder.</summary>
internal static class AssetLinks
{
    internal static AssetLinkPath DataPathOf(Type assetLinkType, string given)
    {
        var assetType = assetLinkType.GetInterfaces().Prepend(assetLinkType)
            .Single(candidate => candidate.IsGenericType && candidate.GetGenericTypeDefinition() == typeof(IAssetLinkGetter<>)).GenericTypeArguments[0];
        try
        {
            return Activator.CreateInstance(typeof(AssetLinkGetter<>).MakeGenericType(assetType), given) is IAssetLinkGetter link
                ? new(link.DataRelativePath.Path, null)
                : throw new InvalidOperationException($"Mutagen holds no asset link of {assetType.Name}.");
        }
        catch (TargetInvocationException e) when (e.InnerException is AssetPathMisalignedException misaligned)
        {
            return new(null, misaligned.Message);
        }
    }
}
