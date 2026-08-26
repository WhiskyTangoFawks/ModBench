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
/// parse (<c>SourceIngest.ReconcileHead</c>) — identity comes from the document, not the path,
/// matching the rest of this codebase's own posture (<c>IRecordIndex.GetDocument</c> et al.).</summary>
internal sealed record SourceRecordIdentity(string PluginFileName, string RecordType);

/// <summary>
/// The source's own file layout policy for <b>flat</b> (single-file) records — one record, one file,
/// under the whole-mod door's own group-folder naming (ADR-0041's #444 amendment, "the source tree
/// adopts Spriggit's layout wholesale"; #451 slice E). Relative to the mod folder:
/// <c>source/&lt;pluginFileName&gt;/&lt;GroupFolder&gt;/[&lt;EditorID&gt; - ]&lt;hex6&gt;_&lt;originModKey&gt;.json</c>.
///
/// <para><b>#441: one root <c>source/</c> folder per mod, not a per-plugin sibling tree.</b> A
/// 2026-08-21 triage retired the prior <c>&lt;pluginFileName&gt;.source/</c> sibling-tree layout
/// (ADR-0041 amendment) in favor of every plugin's tree nesting inside one plain root folder
/// (<see cref="RootFor"/>). That lets the deployer/conflict-index exclusion collapse to two dumb,
/// name-only rules (any dot-prefixed entry, at any depth; a root-level directory literally named
/// <c>source</c>) — neither needs a sibling-plugin check to stay correct, unlike the old per-plugin
/// suffix guard it replaces, which orphaned a tree the moment its plugin was renamed or deleted
/// outside Modbench (#436, and #438's undetected <c>.git</c>). <see cref="RootFor"/> is the one place
/// that builds a plugin's own root — every reader/writer goes through it or through <see cref="For"/>,
/// never hand-rolls the segment.</para>
///
/// <para><b>Only flat records.</b> Cell, Worldspace and Quest (see
/// <see cref="RecordTypeDispatch.FolderNameFor"/>'s own doc comment for why exactly these three) get
/// their own directory (<c>&lt;GroupFolder&gt;/&lt;name&gt;/RecordData.json</c>, with block/sub-block or
/// XY nesting ahead of it for Cell/Worldspace) instead of a flat file — reading and writing that
/// structure is <see cref="SourceUnitResolver"/>'s job (#453), not this helper's.
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
/// reconstructed from memory.</para>
///
/// <para><b>#459: a leading <c>"[N] "</c> ordering prefix ahead of everything above.</b> Once
/// <c>RecordTextCodecCustomization</c> turns <c>Overall.EnforceRecordOrder</c> on, the whole-mod
/// door's own writer numbers every folder-split sibling by its position in the mod's in-memory list —
/// flat top-level groups included, not only the container-nested lists the original ordering bug was
/// measured against (decompiled confirmation lives on
/// <see cref="RecordTextCodecCustomization"/>'s own doc comment). <see cref="For"/>'s
/// <c>orderIndex</c> parameter is the caller's answer to "what position does this sibling occupy",
/// mirroring <c>SerializationHelper.DecorateWithNumber</c> exactly — <c>$"[{orderIndex}] "</c> ahead of
/// the EditorID/FormKey segment, with no extra separator when there's no EditorID either. Required,
/// not optional: a caller that doesn't know the real index would otherwise mint an unprefixed (or
/// wrongly numbered) path that collides or sorts wrong against real siblings the next time the tree is
/// read — <see cref="SourceUnitResolver"/> is where callers that don't already know the index (a fresh
/// create, a delete/renumber's lookup of the file to touch) go to get one.
/// <see cref="TryParse"/> needs no matching change: it never decomposes a leaf file name into
/// EditorID/FormKey/order at all — identity is <c>(pluginFileName, recordType)</c> from path
/// <i>shape</i>, and the two group-file names it special-cases (<see cref="RecordDataFileName"/>/
/// <see cref="GroupRecordDataFileName"/>) are never numbered by the writer either (confirmed:
/// <c>WriteGroupRecordData</c> never calls <c>DecorateWithNumber</c>).</para>
///
/// <para>The <c>&lt;originModKey&gt;</c> segment (the record's <i>origin</i> plugin — <c>FormKey.ModKey</c>
/// — never the plugin the record is written into, which is <paramref name="pluginFileName"/> and can
/// legitimately differ, e.g. an override edited through a patch plugin) is exactly
/// <see cref="FormKey.ToFilesafeString"/>'s own <c>ModKey.FileName</c>, so two records from different
/// masters sharing a local ID never collide on one path (#370, restated for the new layout).</para>
/// </summary>
internal static class SourceRecordPath
{
    /// <summary>The one root folder every plugin's source tree nests inside (#441) — plain, not
    /// dot-prefixed: the plugin's source is first-class, not hidden metadata. Root-anchored deployer
    /// exclusion (Mod Management's <c>fileConflictIndex.ts</c>) matches this literal name at the mod
    /// folder's own root only; a nested directory that happens to share the name (Papyrus ships
    /// <c>Scripts/Source/…</c>) is never this folder and always deploys.</summary>
    internal const string RootFolderName = "source";

    private const string JsonSuffix = ".json";

    // The whole-mod door's own header/group-level files (SerializationHelper.RecordDataFileNameWithoutExtension
    // / TypicalGroupFileName in references/mutagen-serialization) — never a flat record's own file, so
    // TryParse must reject one rather than mistake it for a record whose folder happens to match a
    // known group name.
    private const string RecordDataFileName = "RecordData.json";
    private const string GroupRecordDataFileName = "GroupRecordData.json";

    /// <summary>The plugin's own root under the mod's one <see cref="RootFolderName"/> folder —
    /// <c>source/&lt;pluginFileName&gt;</c>. The single way any reader/writer finds a plugin's tree;
    /// nothing else in this codebase concatenates a plugin name with anything to build it.</summary>
    internal static string RootFor(string pluginFileName) => Path.Combine(RootFolderName, pluginFileName);

    /// <summary>The flat record's path under the Spriggit layout — see this class's own doc comment
    /// for the full shape.</summary>
    /// <param name="orderIndex">This sibling's position among the others in the same group folder —
    /// see this class's own doc comment ("#459") for why it's required rather than optional.</param>
    internal static string For(
        string pluginFileName, string recordType, string formKeyString, string? editorId, GameRelease gameRelease,
        int orderIndex)
    {
        var formKey = FormKey.Factory(formKeyString);
        var folder = RecordTypeDispatch.For(gameRelease).FolderNameFor(recordType)
            ?? throw new NotSupportedException(
                $"'{recordType}' has no flat source path under the Spriggit layout — it is a " +
                "directory-per-record container type (Cell/Worldspace/Quest), or has no top-level " +
                "group at all, and SourceUnitResolver owns it, not this helper.");

        var fileName = string.IsNullOrEmpty(editorId)
            ? $"{FilesafeFormKey(formKey)}{JsonSuffix}"
            : $"{editorId} - {FilesafeFormKey(formKey)}{JsonSuffix}";

        return Path.Combine(RootFor(pluginFileName), folder, $"[{orderIndex}] {fileName}");
    }

    private static string FilesafeFormKey(FormKey formKey) => $"{formKey.ID:X6}_{formKey.ModKey.FileName}";

    /// <summary>Recovers a flat record's plugin/type identity straight from its own path text — no
    /// JSON parse, no git read, matching <see cref="For"/>'s own flat shape exactly (four segments:
    /// <c>source/&lt;plugin&gt;/&lt;GroupFolder&gt;/&lt;file&gt;.json</c>). Fails closed (returns
    /// <see langword="false"/>) on anything not shaped like a path a flat record could produce —
    /// including every container path (<c>Cells/&lt;b&gt;/&lt;sb&gt;/&lt;name&gt;/RecordData.json</c>,
    /// <c>Quests/&lt;name&gt;/RecordData.json</c>) and the root <c>RecordData.json</c> header file —
    /// so a caller walking the whole tree never silently misreads one of those as a flat record.</summary>
    internal static bool TryParse(string relativePath, GameRelease gameRelease, out SourceRecordIdentity identity)
    {
        identity = null!;
        var segments = relativePath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length != 4) return false;

        var (rootSegment, pluginFileName, folder, fileSegment) = (segments[0], segments[1], segments[2], segments[3]);
        if (!rootSegment.Equals(RootFolderName, StringComparison.Ordinal)) return false;
        if (pluginFileName.Length == 0) return false;
        if (!fileSegment.EndsWith(JsonSuffix, StringComparison.Ordinal)) return false;
        if (fileSegment.Equals(RecordDataFileName, StringComparison.Ordinal)) return false;
        if (fileSegment.Equals(GroupRecordDataFileName, StringComparison.Ordinal)) return false;

        var recordType = RecordTypeDispatch.For(gameRelease).RecordTypeForFolder(folder);
        if (recordType is null) return false;

        identity = new SourceRecordIdentity(pluginFileName, recordType);
        return true;
    }
}
