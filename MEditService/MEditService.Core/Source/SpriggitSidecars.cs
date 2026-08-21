using System.Text.Json;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

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
/// plugin file name and its real <c>Mutagen.Bethesda.Plugins.MasterStyle</c> name (<c>"Full"</c>,
/// <c>"Small"</c> — the ESL/light-master flag; the modding scene's own colloquial "light master" is
/// not the enum's own spelling, a #451 review catch — or <c>"Medium"</c>). <c>KnownMaster.Style</c> is
/// itself typed <c>MasterStyle</c> on the real Spriggit side
/// (<c>references/spriggit/Spriggit.Core/SpriggitMeta.cs</c>), so a wrong spelling here is not a
/// cosmetic mismatch — <c>SpriggitFileLocator.Parse</c> rethrows on deserialize failure, and a
/// <c>.spriggit</c> we write would be unreadable by real Spriggit. Resolved from the mod's own header
/// flags (<c>IModFlagsGetter.MasterStyle</c>, <c>references/Mutagen/Mutagen.Bethesda.Core/Plugins/
/// Extensions/IModExt.cs</c>'s <c>GetMasterStyle()</c>), never guessed from the file extension — a
/// small master can carry an <c>.esp</c> extension and vice versa.</summary>
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

    internal static void Write(string treeDirectory, string pluginFileName, IGameSession session)
    {
        var source = SpriggitSource.Current();
        var release = session.GameRelease.ToString();

        var knownMasters = session.Plugins
            .Where(p => p.InLoadOrder)
            .OrderBy(p => p.LoadOrderIndex)
            .Select(p => new SpriggitKnownMaster(p.Name, ResolveMasterStyle(session, p).ToString()))
            .ToList();

        var config = new SpriggitConfigSidecar(source.PackageName, source.Version, release, knownMasters);
        File.WriteAllText(Path.Combine(treeDirectory, SpriggitConfigSidecar.FileName), JsonSerializer.Serialize(config, Options));

        var meta = new SpriggitMetaSidecar(source.PackageName, source.Version, release, pluginFileName);
        File.WriteAllText(Path.Combine(treeDirectory, SpriggitMetaSidecar.FileName), JsonSerializer.Serialize(meta, Options));
    }

    // The real header flag (IModFlagsGetter.MasterStyle), read off whichever mod object the session
    // already holds for this load-order entry — never guessed from the file extension (a small/light
    // master can carry a plain .esp extension and vice versa; #451 review). A plugin the session
    // couldn't resolve (excluded, indexing failure — never-assume-exclusive-ownership) degrades to
    // Full, the enum's own safe default and the style every master was before light masters existed,
    // rather than failing the whole Track over one unresolvable KnownMasters entry.
    private static MasterStyle ResolveMasterStyle(IGameSession session, PluginMetadata plugin) =>
        session.GetMod(plugin.Name, plugin.Origin) is IModFlagsGetter flagged ? flagged.MasterStyle : MasterStyle.Full;
}

/// <summary>Merges <see cref="SpriggitSource"/> into the whole-mod door's own root document — the
/// <c>extraMeta</c> content, written by hand rather than through the mixin's own (defective, see
/// <see cref="SpriggitSource"/>'s own doc comment) <c>extraMeta</c> parameter.
///
/// <para><b>A text splice, not a parse-mutate-reserialize round trip (#451 review).</b> The generator's
/// own <c>WriteLoqui(writer, extraMeta.GetType().Name, extraMeta, ...)</c> call
/// (<c>Mutagen.Bethesda.Serialization.SourceGenerator/Serialization/MixinGenerator.cs</c>, traced at
/// implementation) runs <i>before</i> the mod's own fields serialize, not after — so real Spriggit's
/// root document has <c>SpriggitSource</c> as its <b>first</b> key, and this must too, or a tree we
/// write is not the tree Spriggit would have (#455's byte-parity gate). Parsing the whole document with
/// <c>System.Text.Json</c>, adding a key, and writing it back — this class's first version — gets the
/// key <i>position</i> wrong (appends, since <c>JsonObject</c> preserves insertion order over parse
/// order) and is a second, independent formatting-drift risk on top of that: the document the mixin
/// wrote is Newtonsoft's own <c>Formatting.Indented</c> output, and nothing pins
/// <c>System.Text.Json</c>'s serializer to reproduce it byte-for-byte. Splicing the new key's own text
/// in immediately after the opening <c>{</c>, using whitespace <i>read from the document itself</i> (not
/// assumed — the kernel's own indent width is not pinned anywhere this class can cite), leaves every
/// byte the mixin wrote for its own fields untouched.</para>
/// </summary>
internal static class SpriggitRootHeader
{
    internal const string RecordDataFileName = "RecordData.json";

    internal static void MergeSpriggitSource(string rootRecordDataPath)
    {
        var text = File.ReadAllText(rootRecordDataPath);
        var openBrace = text.IndexOf('{');
        if (openBrace < 0)
            throw new InvalidOperationException($"'{rootRecordDataPath}' did not start with a JSON object.");

        // The whitespace between "{" and the first existing key (typically "\n  ") is this document's
        // own one-level indent, read rather than assumed — whatever width/newline convention the
        // kernel used, the spliced-in key matches it exactly because it's built from the same string.
        var afterBrace = openBrace + 1;
        var firstKeyStart = afterBrace;
        while (firstKeyStart < text.Length && char.IsWhiteSpace(text[firstKeyStart])) firstKeyStart++;
        var oneIndent = text[afterBrace..firstKeyStart];
        if (oneIndent.Length == 0)
            throw new InvalidOperationException($"'{rootRecordDataPath}' has no existing field to read this document's indent from.");
        var twoIndent = oneIndent + oneIndent[(oneIndent.LastIndexOf('\n') + 1)..];

        var source = SpriggitSource.Current();
        var spliced =
            $"{oneIndent}\"{nameof(SpriggitSource)}\": {{" +
            $"{twoIndent}\"{nameof(SpriggitSource.PackageName)}\": \"{source.PackageName}\"," +
            $"{twoIndent}\"{nameof(SpriggitSource.Version)}\": \"{source.Version}\"" +
            $"{oneIndent}}},";

        File.WriteAllText(rootRecordDataPath, text[..afterBrace] + spliced + text[firstKeyStart..]);
    }
}
