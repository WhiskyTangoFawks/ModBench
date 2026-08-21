using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>A flat record's identity as recovered from its own source path — the inverse of
/// <see cref="SourceRecordPath.For"/>. No <c>FormKey</c> field (#451 review): the whole-mod door's own
/// file name embeds EditorID ahead of the FormKey (<c>"&lt;EditorID&gt; - &lt;hex6&gt;_&lt;ModKeyFileName&gt;.json"</c>),
/// and an EditorID can itself legally contain <c>" - "</c>, which makes recovering a FormKey by
/// splitting the filename alone ambiguous in the general case. Every caller either already holds the
/// record's bytes (<c>PluginCompileService</c>, which never needed a path-derived FormKey — the
/// deserialized record's own <c>FormKey</c> is authoritative) or reads them right after a successful
/// parse (<c>WorkingTreeCreateRediscovery</c>) — identity comes from the document, not the path,
/// matching the rest of this codebase's own posture (<c>IRecordIndex.GetDocument</c> et al.).</summary>
internal sealed record SourceRecordIdentity(string PluginFileName, string RecordType);

/// <summary>
/// The source's own file layout policy for <b>flat</b> (single-file) records — one record, one file,
/// under the whole-mod door's own group-folder naming (ADR-0041's #444 amendment, "the source tree
/// adopts Spriggit's layout wholesale"; #451 slice E). Relative to the origin folder (the source's
/// working tree):
/// <c>&lt;pluginFileName&gt;.source/&lt;GroupFolder&gt;/[&lt;EditorID&gt; - ]&lt;hex6&gt;_&lt;originModKey&gt;.json</c>.
///
/// <para><b>Only flat records.</b> Cell, Worldspace and Quest (see
/// <see cref="RecordTypeDispatch.FolderNameFor"/>'s own doc comment for why exactly these three) get
/// their own directory (<c>&lt;GroupFolder&gt;/&lt;name&gt;/RecordData.json</c>, with block/sub-block or
/// XY nesting ahead of it for Cell/Worldspace) instead of a flat file — reading and writing that
/// structure is #453/#454's job ("compile/ingest reads structure from the tree"), not this helper's.
/// <see cref="For"/> refuses (a named exception, never a silently wrong flat path) for any record type
/// that resolves to one of those three or to no top-level group at all; <see cref="TryParse"/> simply
/// answers false for any path deeper or shallower than the flat shape.</para>
///
/// <para><b>The folder segment is the whole-mod door's own group-property name</b> (<c>"Npcs"</c>,
/// <c>"Weapons"</c>) — traced to <c>FolderPerRecordGroupFieldGenerator</c>/<c>GroupParallelHelper</c>
/// in <c>references/mutagen-serialization</c>, not invented — via <see cref="RecordTypeDispatch"/>'s
/// reflection, the same source <see cref="RecordTextCodec"/>'s own discriminator policy reads. The
/// file name segment mirrors <c>Mutagen.Bethesda.Core</c>'s own <c>FormKey.ToFilesafeString()</c>
/// (<c>"{hex6}_{ModKeyFileName}"</c>) with an optional <c>"{EditorID} - "</c> prefix — exactly
/// <c>SerializationHelper.RecordFileNameProvider</c>'s own scheme, verified against
/// <c>references/mutagen-serialization</c> and <c>references/Mutagen</c> at implementation (#451), not
/// reconstructed from memory. No <c>[N] </c> ordering prefix: that is gated on
/// <c>Overall.EnforceRecordOrder</c>, which neither this project's customizations nor Spriggit's own
/// (grepped, zero call sites) ever turn on.</para>
///
/// <para>The <c>&lt;originModKey&gt;</c> segment (the record's <i>origin</i> plugin — <c>FormKey.ModKey</c>
/// — never the plugin the record is written into, which is <paramref name="pluginFileName"/> and can
/// legitimately differ, e.g. an override edited through a patch plugin) is exactly
/// <see cref="FormKey.ToFilesafeString"/>'s own <c>ModKey.FileName</c>, so two records from different
/// masters sharing a local ID never collide on one path (#370, restated for the new layout).</para>
/// </summary>
internal static class SourceRecordPath
{
    internal const string SourceSuffix = ".source";
    private const string JsonSuffix = ".json";

    // The whole-mod door's own header/group-level files (SerializationHelper.RecordDataFileNameWithoutExtension
    // / TypicalGroupFileName in references/mutagen-serialization) — never a flat record's own file, so
    // TryParse must reject one rather than mistake it for a record whose folder happens to match a
    // known group name.
    private const string RecordDataFileName = "RecordData.json";
    private const string GroupRecordDataFileName = "GroupRecordData.json";

    internal static string For(
        string pluginFileName, string recordType, string formKeyString, string? editorId, GameRelease gameRelease)
    {
        var formKey = FormKey.Factory(formKeyString);
        var folder = RecordTypeDispatch.For(gameRelease).FolderNameFor(recordType)
            ?? throw new NotSupportedException(
                $"'{recordType}' has no flat source path under the Spriggit layout — it is a " +
                "directory-per-record container type (Cell/Worldspace/Quest), or has no top-level " +
                "group at all, and #453/#454's structure-aware reader owns it, not this helper.");

        var fileName = string.IsNullOrEmpty(editorId)
            ? $"{FilesafeFormKey(formKey)}{JsonSuffix}"
            : $"{editorId} - {FilesafeFormKey(formKey)}{JsonSuffix}";

        return Path.Combine($"{pluginFileName}{SourceSuffix}", folder, fileName);
    }

    private static string FilesafeFormKey(FormKey formKey) => $"{formKey.ID:X6}_{formKey.ModKey.FileName}";

    /// <summary>Recovers a flat record's plugin/type identity straight from its own path text — no
    /// JSON parse, no git read, matching <see cref="For"/>'s own flat shape exactly (three segments:
    /// <c>&lt;plugin&gt;.source/&lt;GroupFolder&gt;/&lt;file&gt;.json</c>). Fails closed (returns
    /// <see langword="false"/>) on anything not shaped like a path a flat record could produce —
    /// including every container path (<c>Cells/&lt;b&gt;/&lt;sb&gt;/&lt;name&gt;/RecordData.json</c>,
    /// <c>Quests/&lt;name&gt;/RecordData.json</c>) and the root <c>RecordData.json</c> header file —
    /// so a caller walking the whole tree never silently misreads one of those as a flat record.</summary>
    internal static bool TryParse(string relativePath, GameRelease gameRelease, out SourceRecordIdentity identity)
    {
        identity = null!;
        var segments = relativePath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length != 3) return false;

        var (pluginSegment, folder, fileSegment) = (segments[0], segments[1], segments[2]);
        if (!pluginSegment.EndsWith(SourceSuffix, StringComparison.Ordinal)) return false;
        if (!fileSegment.EndsWith(JsonSuffix, StringComparison.Ordinal)) return false;
        if (fileSegment.Equals(RecordDataFileName, StringComparison.Ordinal)) return false;
        if (fileSegment.Equals(GroupRecordDataFileName, StringComparison.Ordinal)) return false;

        var pluginFileName = pluginSegment[..^SourceSuffix.Length];
        if (pluginFileName.Length == 0) return false;

        var recordType = RecordTypeDispatch.For(gameRelease).RecordTypeForFolder(folder);
        if (recordType is null) return false;

        identity = new SourceRecordIdentity(pluginFileName, recordType);
        return true;
    }
}
