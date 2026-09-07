using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>The source layout's stateless helpers: how a record's leaf is named, where a flat one
/// lands, how a document's bytes become one record's text. Which document holds a record is the
/// repository's question.</summary>
internal static class SourceUnitResolver
{
    /// <summary>The whole-mod door's own name for a directory-per-record container's field file
    /// (<c>SerializationHelper.RecordDataFileNameWithoutExtension</c> plus the JSON kernel's
    /// extension).</summary>
    internal const string RecordDataFileName = "RecordData.json";

    /// <summary>The whole-mod door's own name for a group or block level's metadata file, written only
    /// when the level has non-default metadata.</summary>
    internal const string GroupRecordDataFileName = "GroupRecordData.json";

    internal const string JsonSuffix = ".json";

    /// <summary>The computed path when it exists, else whichever file in the group folder carries this
    /// FormKey. Name and document EditorIDs can disagree, and trusting the name alone would read a live
    /// record as deleted.</summary>
    internal static string FlatSourcePath(
        string modFolder, string pluginFileName, string recordType, string formKey, string? editorId,
        GameRelease release)
    {
        var computed = Path.Combine(
            modFolder, SourceRecordPath.For(pluginFileName, recordType, formKey, editorId, release));
        if (File.Exists(computed)) return computed;

        var groupFolder = RecordTypeDispatch.For(release).FolderNameFor(recordType);
        if (groupFolder == null) return computed;

        var groupDirectory = Path.Combine(modFolder, SourceRecordPath.RootFor(pluginFileName), groupFolder);
        if (!Directory.Exists(groupDirectory)) return computed;

        var suffix = FilesafeFormKey(formKey) + JsonSuffix;
        var matches = Directory
            .EnumerateFiles(groupDirectory, $"*{suffix}", SearchOption.TopDirectoryOnly)
            .Where(f => NameCarries(Path.GetFileName(f), suffix))
            .Take(2)
            .ToList();

        return matches.Count switch
        {
            0 => computed,
            1 => matches[0],
            _ => throw new AmbiguousSourceUnitException(
                $"More than one file in '{groupDirectory}' claims FormKey {formKey}. A FormKey is unique " +
                "within a mod, so this tree is corrupt — most likely a rename that was interrupted " +
                "partway. Resolve the duplicate by hand before editing."),
        };
    }

    /// <summary>Which FormKeys more than one source unit claims. Asked of the tree, not the compiled mod:
    /// the reader's FormKey-keyed RecordCache silently collapses two files in one group folder to the
    /// last read.</summary>
    internal static IReadOnlyList<string> FormKeysWithMoreThanOneSourceUnit(
        string sourceRoot, IEnumerable<FormKey> formKeys)
    {
        if (!Directory.Exists(sourceRoot)) return [];

        var unitsByTail = new Dictionary<string, int>(StringComparer.Ordinal);
        void Count(string leaf)
        {
            foreach (var tail in TailsCarriedBy(leaf))
            {
                unitsByTail[tail] = unitsByTail.GetValueOrDefault(tail) + 1;
            }
        }

        // Group-level files and block directories carry no FormKey, so they never match a tail and need no
        // exclusion.
        foreach (var directory in Directory.EnumerateDirectories(sourceRoot, "*", SearchOption.AllDirectories))
            Count(Path.GetFileName(directory));
        foreach (var file in Directory.EnumerateFiles(sourceRoot, $"*{JsonSuffix}", SearchOption.AllDirectories))
            Count(Path.GetFileName(file));

        var colliding = new List<string>();
        foreach (var formKey in formKeys)
        {
            var filesafe = LeafNameFor(formKey, editorId: null, isDirectory: true);
            var units = unitsByTail.GetValueOrDefault(filesafe)
                        + unitsByTail.GetValueOrDefault(filesafe + JsonSuffix);
            if (units > 1) colliding.Add(formKey.ToString());
        }
        return colliding;
    }

    // More than one candidate arises only when an EditorID itself contains " - "; a non-FormKey
    // candidate is simply never looked up.
    private static IEnumerable<string> TailsCarriedBy(string leaf)
    {
        yield return leaf;

        const string separator = " - ";
        var at = leaf.IndexOf(separator, StringComparison.Ordinal);
        while (at >= 0)
        {
            yield return leaf[(at + separator.Length)..];
            at = leaf.IndexOf(separator, at + separator.Length, StringComparison.Ordinal);
        }
    }

    /// <summary>Whether <paramref name="leaf"/> names the record with <paramref name="formKey"/> — asked
    /// in the one unambiguous direction, since an EditorID containing <c>" - "</c> makes splitting a
    /// name undecidable.</summary>
    internal static bool NameCarriesFormKey(string leaf, string formKey)
    {
        var filesafe = FilesafeFormKey(formKey);
        return NameCarries(leaf, filesafe) || NameCarries(leaf, filesafe + JsonSuffix);
    }

    // The whole-mod door's two name shapes: the filesafe FormKey alone, or "<EditorID> - " ahead of it.
    // Anchored at both ends so a name that merely embeds the text cannot match.
    internal static bool NameCarries(string leaf, string tail) =>
        leaf.Equals(tail, StringComparison.Ordinal)
        || (leaf.EndsWith(tail, StringComparison.Ordinal)
            && leaf.EndsWith($" - {tail}", StringComparison.Ordinal));

    /// <summary>One place that knows a container is a directory and a flat record a file, so callers and
    /// the rollback cannot disagree.</summary>
    internal static void MoveEntry(string from, string to)
    {
        if (Directory.Exists(from)) Directory.Move(from, to);
        else File.Move(from, to);
    }

    /// <summary>The codec's own write-then-rename, for the writers that hold text rather than a
    /// record: an interrupted direct write leaves a partial file that dirty detection reads as an
    /// edit.</summary>
    internal static void WriteTextAtomic(string filePath, string body)
    {
        var tempPath = filePath + ".tmp";
        try
        {
            File.WriteAllText(tempPath, body);
            File.Move(tempPath, filePath, overwrite: true);
        }
        catch
        {
            File.Delete(tempPath);
            throw;
        }
    }

    /// <summary>Removes the directories this call minted when <paramref name="write"/> throws: an
    /// empty record directory is invisible to git and fails the next ingest, since the reader opens
    /// every one unconditionally.</summary>
    internal static T InMintedDirectory<T>(string directory, Func<T> write)
    {
        var minted = new List<string>();
        for (var level = directory; !string.IsNullOrEmpty(level) && !Directory.Exists(level); level = Path.GetDirectoryName(level))
            minted.Add(level);

        try
        {
            Directory.CreateDirectory(directory);
            return write();
        }
        catch
        {
            // Deepest first, by construction of the walk above — so a parent is already empty by the
            // time it is reached, and needs no second pass.
            foreach (var stray in minted)
            {
                // Never reached (the create died at an ancestor): skip, so the levels that did land are still
                // removed.
                if (!Directory.Exists(stray)) continue;

                try { Directory.Delete(stray); }
                catch (DirectoryNotFoundException) { /* vanished under us; its ancestors still stand */ }
                catch (IOException) { break; }
                catch (UnauthorizedAccessException) { break; }
            }
            throw;
        }
    }

    internal static void InMintedDirectory(string directory, Action write) =>
        InMintedDirectory(directory, () => { write(); return true; });

    /// <summary>The record's own text out of the bytes <paramref name="unit"/>'s file holds: itself for
    /// a flat record, or re-extracted for an embedded child. RefreshByKeys's write.</summary>
    internal static string? RecordBodyFromOwnerBytes(
        byte[]? ownerBytes, SourceUnit unit, string formKey, GameRelease release, RecordTextCodec codec)
    {
        if (ownerBytes == null) return null;

        // File.ReadAllText strips a UTF-8 BOM; raw bytes do not — unstripped, a BOM-carrying file
        // would never compare equal to the codec's BOM-free text.
        ownerBytes = StripUtf8Bom(ownerBytes);

        if (!unit.IsEmbedded) return Encoding.UTF8.GetString(ownerBytes);

        var owner = codec.DeserializeFromBytesAsync(ownerBytes, release, unit.OwnerRecordType).GetAwaiter().GetResult();
        if (ContainerChildFields.FindEmbeddedChild(owner, formKey) is not { } found) return null;

        var childBytes = codec.SerializeToBytesAsync(found.Child, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(childBytes);
    }

    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    internal static byte[] StripUtf8Bom(byte[] bytes) =>
        bytes.AsSpan(0, Math.Min(bytes.Length, Utf8Bom.Length)).SequenceEqual(Utf8Bom) ? bytes[Utf8Bom.Length..] : bytes;

    /// <summary><c>[&lt;EditorID&gt; - ]&lt;hex6&gt;_&lt;originModKey&gt;</c>, with <c>.json</c> for a flat
    /// file and without for a container's directory — the reason an EditorID edit is a rename.</summary>
    internal static string LeafNameFor(FormKey formKey, string? editorId, bool isDirectory)
    {
        var extension = isDirectory ? string.Empty : JsonSuffix;
        var filesafe = $"{formKey.ID:X6}_{formKey.ModKey.FileName}";

        return string.IsNullOrEmpty(editorId) ? $"{filesafe}{extension}" : $"{editorId} - {filesafe}{extension}";
    }

    internal static string FilesafeFormKey(string formKey)
    {
        var parsed = FormKey.Factory(formKey);
        return $"{parsed.ID:X6}_{parsed.ModKey.FileName}";
    }
}

/// <summary>Two source units under one plugin's tree carry the same FormKey: corruption, not a
/// transient condition. An <see cref="InvalidOperationException"/> so the read path degrades on it;
/// only the write path refuses.</summary>
public sealed class AmbiguousSourceUnitException : InvalidOperationException
{
    public AmbiguousSourceUnitException() : base("More than one source unit claims one FormKey.")
    {
    }

    public AmbiguousSourceUnitException(string message) : base(message)
    {
    }

    public AmbiguousSourceUnitException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
