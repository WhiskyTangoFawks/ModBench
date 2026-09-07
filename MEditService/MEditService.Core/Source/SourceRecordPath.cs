using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>A flat record's identity as recovered from its own path. No FormKey: an EditorID can
/// legally contain <c>" - "</c>, so splitting the file name is ambiguous. Identity comes from the
/// document, not the path.</summary>
internal sealed record SourceRecordIdentity(string PluginFileName, string RecordType);

/// <summary>The file layout for flat (single-file) records — the whole-mod door's own file-per-record
/// convention, taken over wholesale (ADR-0041 amendment). Cell and Worldspace get a directory
/// instead; <see cref="SourceRepository.Locate"/> owns those.</summary>
internal static class SourceRecordPath
{
    /// <summary>Plain, not dot-prefixed: the plugin's source is first-class, not hidden metadata. The
    /// deployer exclusion matches this literal name at the mod folder root only, so a nested
    /// <c>Scripts/Source/</c> always deploys.</summary>
    internal const string RootFolderName = "source";

    private const string JsonSuffix = ".json";

    // The whole-mod door's own header/group-level file names — never a flat record's file, so TryParse
    // must reject them rather than mistake one for a record.
    private const string RecordDataFileName = SourceUnitResolver.RecordDataFileName;
    private const string GroupRecordDataFileName = SourceUnitResolver.GroupRecordDataFileName;

    /// <summary><c>source/&lt;pluginFileName&gt;</c>, one root rather than a per-plugin sibling tree: a
    /// per-plugin suffix guard orphans the tree when its plugin is renamed or deleted outside Modbench.</summary>
    internal static string RootFor(string pluginFileName) => Path.Combine(RootFolderName, pluginFileName);

    /// <summary><c>source/&lt;plugin&gt;/&lt;GroupFolder&gt;/[&lt;EditorID&gt; - ]&lt;hex6&gt;_&lt;originModKey&gt;.json</c>;
    /// the origin ModKey (never the plugin written into) keeps two masters' records from colliding on
    /// one path.</summary>
    internal static string For(
        string pluginFileName, string recordType, string formKeyString, string? editorId, GameRelease gameRelease)
    {
        var formKey = FormKey.Factory(formKeyString);
        var folder = RecordTypeDispatch.For(gameRelease).FolderNameFor(recordType)
            ?? throw new NotSupportedException(
                $"'{recordType}' has no flat source path under the source layout — it is a " +
                "directory-per-record container type (Cell/Worldspace), or has no top-level " +
                "group at all, and the repository's own locator owns it, not this helper.");

        var fileName = string.IsNullOrEmpty(editorId)
            ? $"{FilesafeFormKey(formKey)}{JsonSuffix}"
            : $"{editorId} - {FilesafeFormKey(formKey)}{JsonSuffix}";

        return Path.Combine(RootFor(pluginFileName), folder, fileName);
    }

    private static string FilesafeFormKey(FormKey formKey) => $"{formKey.ID:X6}_{formKey.ModKey.FileName}";

    /// <summary>The record type of the document at <paramref name="relativePath"/>. Null means the
    /// path does not decide it, so the document names its own type.</summary>
    internal static string? RecordTypeOf(string relativePath, GameRelease gameRelease)
    {
        if (TryParse(relativePath, gameRelease, out var identity)) return identity.RecordType;

        // source / <plugin> / <group folder> / [block levels] / <record directory> / RecordData.json
        var segments = relativePath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        const int groupFolderSegment = 2;
        const int shallowestContainer = 5;
        return segments.Length >= shallowestContainer
               && segments[^1].Equals(RecordDataFileName, StringComparison.Ordinal)
            ? RecordTypeDispatch.For(gameRelease)
                .DirectoryPerRecordTypeIn(segments[groupFolderSegment], nested: segments.Length > shallowestContainer)
            : null;
    }

    /// <summary>Fails closed on anything not shaped like a flat record's path or the header's root
    /// <c>RecordData.json</c> (one segment shallower), so a tree walk never misreads a container path
    /// as a flat record.</summary>
    internal static bool TryParse(string relativePath, GameRelease gameRelease, out SourceRecordIdentity identity)
    {
        identity = null!;
        var segments = relativePath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);

        if (segments.Length == 3
            && segments[0].Equals(RootFolderName, StringComparison.Ordinal)
            && segments[1].Length > 0
            && segments[2].Equals(RecordDataFileName, StringComparison.Ordinal))
        {
            identity = new SourceRecordIdentity(segments[1], PluginHeader.RecordType);
            return true;
        }

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
