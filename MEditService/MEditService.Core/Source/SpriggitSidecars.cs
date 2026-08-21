using System.Text.Json;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Core.Source;

/// <summary>
/// The Spriggit package coordinates a tracked mod's root document carries — ADR-0041's #444 amendment,
/// "Sidecars verbatim, nothing extra" names this as the whole-mod door's own <c>extraMeta</c> object,
/// merged into the root <c>RecordData.json</c> by <see cref="SpriggitRootHeader.MergeSpriggitSource"/>
/// instead (see <see cref="Serialization.RecordTextCodecGeneratorSeed"/>'s own doc comment for why: the
/// generated mixin's <c>extraMeta</c> parameter hits a real generator overload-collision defect on this
/// project's 1.37.1 pin). Field for field identical to <c>Spriggit.Core.SpriggitSource</c>
/// (<c>references/spriggit/Spriggit.Core/SpriggitSource.cs</c>, read at implementation) — replicated,
/// never referenced: Spriggit is a format specification, never a code dependency (ADR-0041's #444
/// amendment, point 3).
/// </summary>
internal sealed class SpriggitSource
{
    public string PackageName { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;

    // Resolved from the NuGet v3 flat-container index for Spriggit.Json.Fallout4
    // (https://api.nuget.org/v3-flatcontainer/spriggit.json.fallout4/index.json, read 2026-08-21):
    // the newest non-prerelease entry in the versions array. Re-check there before bumping this —
    // the parity/interchange gates (#444 amendment) are what adjudicate drift once they exist.
    internal const string CurrentPackageName = "Spriggit.Json.Fallout4";
    internal const string CurrentVersion = "0.41.0";

    internal static SpriggitSource Current() => new() { PackageName = CurrentPackageName, Version = CurrentVersion };
}

/// <summary>
/// The Spriggit CLI's own pin/config file (<c>Spriggit.Core.Services.Singletons.SpriggitFileLocator</c>:
/// <c>ConfigFileName = ".spriggit"</c>), written beside the tree root by Track — field names mirror
/// <c>SpriggitFileSerialize</c>/<c>KnownMaster</c> (both in <c>references/spriggit/Spriggit.Core</c>),
/// replicated rather than referenced for the same reason as <see cref="SpriggitSource"/>.
/// </summary>
internal sealed record SpriggitConfigSidecar(
    string PackageName, string Version, string Release, IReadOnlyList<SpriggitKnownMaster> KnownMasters)
{
    internal const string FileName = ".spriggit";
}

/// <summary>One load-order entry as <c>.spriggit</c>'s own <c>KnownMasters</c> array holds it — a
/// plugin file name and a coarse master style (<c>"Light"</c> for an <c>.esl</c>, <c>"Full"</c>
/// otherwise; Spriggit's own finer <c>MasterStyle</c> distinctions are not read back by anything this
/// project builds, so this is not attempting parity beyond the two styles the extension itself
/// carries).</summary>
internal sealed record SpriggitKnownMaster(string ModKey, string Style);

/// <summary>
/// The whole-mod door's own auto-persisted meta file (<c>Spriggit.Engine.Services.Singletons.
/// SpriggitExternalMetaPersister</c>: <c>FileName = "spriggit-meta.json"</c>, current since their
/// 0.25.0 swap from the legacy <c>spriggit.meta</c> name) — written beside the tree root, alongside
/// <see cref="SpriggitConfigSidecar"/>. Field names mirror <c>SpriggitModKeyMetaSerialize</c>.
/// </summary>
internal sealed record SpriggitMetaSidecar(string PackageName, string Version, string Release, string ModKey)
{
    internal const string FileName = "spriggit-meta.json";
}

/// <summary>Writes both sidecars beside a just-serialized tree — the two-file half of "Sidecars
/// verbatim, nothing extra"; the third piece (<c>extraMeta</c> in the root document) is written by the
/// whole-mod door itself and needs no separate file write.</summary>
internal static class SpriggitSidecarWriter
{
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    internal static void Write(string treeDirectory, string pluginFileName, GameRelease gameRelease, IReadOnlyList<PluginMetadata> loadOrder)
    {
        var source = SpriggitSource.Current();
        var release = gameRelease.ToString();

        var knownMasters = loadOrder
            .Where(p => p.InLoadOrder)
            .OrderBy(p => p.LoadOrderIndex)
            .Select(p => new SpriggitKnownMaster(p.Name, IsLightMaster(p.Name) ? "Light" : "Full"))
            .ToList();

        var config = new SpriggitConfigSidecar(source.PackageName, source.Version, release, knownMasters);
        File.WriteAllText(Path.Combine(treeDirectory, SpriggitConfigSidecar.FileName), JsonSerializer.Serialize(config, Options));

        var meta = new SpriggitMetaSidecar(source.PackageName, source.Version, release, pluginFileName);
        File.WriteAllText(Path.Combine(treeDirectory, SpriggitMetaSidecar.FileName), JsonSerializer.Serialize(meta, Options));
    }

    private static bool IsLightMaster(string pluginFileName) =>
        pluginFileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase);
}

/// <summary>Merges <see cref="SpriggitSource"/> into the whole-mod door's own root document — the
/// <c>extraMeta</c> content, written by hand rather than through the mixin's own (defective, see
/// <see cref="SpriggitSource"/>'s own doc comment) <c>extraMeta</c> parameter. The merged shape matches
/// what the generator's own <c>WriteLoqui(writer, extraMeta.GetType().Name, extraMeta, ...)</c> would
/// have produced: a top-level property named after the object's own type
/// (<c>Mutagen.Bethesda.Serialization.SourceGenerator/Serialization/MixinGenerator.cs</c>, traced at
/// implementation), holding its public properties.</summary>
internal static class SpriggitRootHeader
{
    internal const string RecordDataFileName = "RecordData.json";

    internal static void MergeSpriggitSource(string rootRecordDataPath)
    {
        var root = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(rootRecordDataPath))?.AsObject()
            ?? throw new InvalidOperationException($"'{rootRecordDataPath}' did not parse as a JSON object.");

        var source = SpriggitSource.Current();
        root[nameof(SpriggitSource)] = new System.Text.Json.Nodes.JsonObject
        {
            [nameof(SpriggitSource.PackageName)] = source.PackageName,
            [nameof(SpriggitSource.Version)] = source.Version,
        };

        File.WriteAllText(rootRecordDataPath, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }
}
