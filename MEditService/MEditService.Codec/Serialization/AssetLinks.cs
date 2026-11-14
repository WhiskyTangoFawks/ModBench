using System.Reflection;
using MEditService.Codec.Schema;
using Mutagen.Bethesda.Plugins.Assets;
using Mutagen.Bethesda.Plugins.Exceptions;

namespace MEditService.Codec.Serialization;

/// <summary>The path in the Data folder an asset link holds, or why its asset type cannot hold the path.</summary>
internal readonly record struct AssetLinkPath(string? DataPath, string? Refusal);

/// <summary>Mutagen places a path under its asset type's folder.</summary>
internal static class AssetLinks
{
    internal static AssetType TypeOf(Type assetLinkType)
    {
        var assetType = LinkOf(assetLinkType).AssetTypeInstance;
        return new(assetType.BaseFolder.Replace('\\', '/'), [.. assetType.FileExtensions]);
    }

    internal static AssetLinkPath DataPathOf(Type assetLinkType, string given)
    {
        try
        {
            return new(LinkOf(assetLinkType, given).DataRelativePath.Path.Replace('\\', '/'), null);
        }
        catch (TargetInvocationException e) when (e.InnerException is AssetPathMisalignedException misaligned)
        {
            return new(null, misaligned.Message);
        }
    }

    private static IAssetLinkGetter LinkOf(Type assetLinkType, params object[] arguments)
    {
        var assetType = assetLinkType.GetInterfaces().Prepend(assetLinkType)
            .Single(candidate => candidate.IsGenericType && candidate.GetGenericTypeDefinition() == typeof(IAssetLinkGetter<>)).GenericTypeArguments[0];
        return Activator.CreateInstance(typeof(AssetLinkGetter<>).MakeGenericType(assetType), arguments) as IAssetLinkGetter
            ?? throw new InvalidOperationException($"Mutagen holds no asset link of {assetType.Name}.");
    }
}
