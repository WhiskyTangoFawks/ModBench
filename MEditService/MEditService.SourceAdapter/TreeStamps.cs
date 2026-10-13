using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>A file of a plugin's tree, as the source folder spells it, that could not be read as a
/// document, and the FormKey it was read for when one is known.</summary>
public sealed record UnreadableFile(string SourceRelativePath, string Message, string? FormKey = null);

/// <summary>A FormKey a plugin's tree holds more than once, with the documents holding it as the mod
/// folder spells them: one document when that document holds it twice.</summary>
public sealed record ClaimedFormKey(string FormKey, IReadOnlyList<string> Documents)
{
    public string Message =>
        (Documents is [var only]
            ? $"'{only}' holds {FormKey} more than once."
            : $"More than one document in this plugin's source tree holds {FormKey}: " +
              $"{string.Join(", ", Documents.Select(d => $"'{d}'"))}.") +
        " A FormKey is unique within a plugin, so the tree is corrupt — most likely a copy or an interrupted " +
        "rename. Remove the duplicate by hand.";

    public bool Equals(ClaimedFormKey? other) =>
        other is not null && FormKey == other.FormKey && Documents.SequenceEqual(other.Documents);

    public override int GetHashCode() => FormKey.GetHashCode(StringComparison.Ordinal);
}

/// <summary>Every document of a plugin's tree by the FormKey it declares, with its content stamp; each
/// file that is no document; each FormKey declared twice; each file read as unsaved text; each file the
/// layout places elsewhere.</summary>
public sealed record RecordStamps(
    IReadOnlyDictionary<string, string> ByFormKey, IReadOnlyList<UnreadableFile> Unreadable,
    IReadOnlyList<ClaimedFormKey> Claimed, IReadOnlySet<string> Unsaved, IReadOnlyList<MisplacedFile> Misplaced)
{
    /// <summary>Equal when the same documents carry the same stamps, and the same files could not be
    /// read, claim one FormKey or were read unsaved.</summary>
    public bool Equals(RecordStamps? other) =>
        other is not null
        && ByFormKey.Count == other.ByFormKey.Count
        && ByFormKey.All(stamp => other.ByFormKey.TryGetValue(stamp.Key, out var theirs) && theirs == stamp.Value)
        && Unreadable.SequenceEqual(other.Unreadable)
        && Claimed.SequenceEqual(other.Claimed)
        && Unsaved.SetEquals(other.Unsaved);

    /// <summary>Each file that does not read was read unsaved, and so was every document but one of
    /// each FormKey claimed more than once.</summary>
    public bool StoppedOnlyByUnsavedText =>
        (Unreadable.Count > 0 || Claimed.Count > 0)
        && Unreadable.All(file => Unsaved.Contains(file.SourceRelativePath))
        && Claimed.All(claim => claim.Documents.Count(document => !Unsaved.Contains(document)) <= 1);

    /// <summary>What stops a read of this tree at its first file that does not read, when one does not.</summary>
    public SourceFailure? FirstUnreadable =>
        Unreadable.Count > 0 ? SourceStopException.Unreadable(Unreadable[0]).Failure : null;

    public override int GetHashCode() => ByFormKey.Count;
}

/// <summary>A record's content stamp: what the index remembers of a document, and what the tree is
/// asked against (ADR-0003).</summary>
internal static class TreeStamps
{
    private static readonly ConcurrentDictionary<string, StampGatedMemo<KnownDocument>> Known =
        new(StringComparer.Ordinal);

    private sealed record KnownDocument(
        string? FormKey, string Content, IReadOnlyList<string> FormKeys, string? Refusal, FormIdLimit? Limit, string? BelongsAt);

    internal static string ContentStamp(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    internal static RecordStamps StampsOf(string sourceFolder, PluginAddress plugin, GameRelease release, ISourceFiles files)
    {
        var unreadable = new List<UnreadableFile>();
        var holders = new OneDocumentPerFormKey(sourceFolder);
        var stamps = new Dictionary<string, string>(StringComparer.Ordinal);
        var unsaved = new HashSet<string>(StringComparer.Ordinal);

        var root = SourceRepositoryLayout.RootIn(sourceFolder, plugin.Name);
        foreach (var gone in Known.Keys.Where(tree => !Directory.Exists(tree))) Known.TryRemove(gone, out _);
        var known = Known.GetOrAdd(root, _ => new StampGatedMemo<KnownDocument>(TimeProvider.System));
        var listed = new HashSet<string>(StringComparer.Ordinal);
        var misplaced = new List<MisplacedFile>();
        var keysByFile = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        FormIdLimit? limit = null;
        if (Directory.Exists(root))
        {
            // Keyed by the FormKey the document declares, never by its path: a file name carries an
            // EditorID that may contain the separator, so a path is not a decidable identity.
            foreach (var file in Directory.EnumerateFiles(root, $"*{SourceRepositoryLayout.JsonSuffix}", SearchOption.AllDirectories))
            {
                if (!file.EndsWith(SourceRepositoryLayout.JsonSuffix, StringComparison.OrdinalIgnoreCase)) continue;
                listed.Add(file);

                var relativePath = Path.GetRelativePath(sourceFolder, file);
                // An unsaved text moves no file-system stamp, so it is read every time.
                var readUnsaved = files.HoldsUnsavedText(file);
                if (readUnsaved) unsaved.Add(relativePath);
                var document = readUnsaved
                    ? Read(files, file, relativePath, plugin.Name, release, unreadable)
                    : known.Of(file, () => Read(files, file, relativePath, plugin.Name, release, unreadable));
                if (document is null) continue;
                if (document.FormKey is not { } formKey)
                {
                    if (document.Refusal is { } fault) unreadable.Add(new UnreadableFile(relativePath, fault));
                    continue;
                }
                holders.Hold(formKey, file);
                stamps[formKey] = document.Content;
                keysByFile[relativePath] = document.FormKeys;
                limit ??= document.Limit;
                if (document.BelongsAt is { } belongsAt) misplaced.Add(new MisplacedFile(formKey, relativePath, belongsAt));
                if (document.Refusal is { } refusal) unreadable.Add(new UnreadableFile(relativePath, refusal, formKey));
            }
        }

        known.Retain(listed);
        var claimedDocuments = holders.Claimed.SelectMany(claim => claim.Documents).ToHashSet(StringComparer.Ordinal);
        misplaced.RemoveAll(file => claimedDocuments.Contains(file.HeldPath));
        if (limit is not null) unreadable.AddRange(OutsideTheLimit(limit, plugin, keysByFile));
        return new RecordStamps(stamps, unreadable, holders.Claimed, unsaved, misplaced);
    }

    private static IEnumerable<UnreadableFile> OutsideTheLimit(
        FormIdLimit limit, PluginAddress plugin, Dictionary<string, IReadOnlyList<string>> keysByFile)
    {
        var modKey = ModKey.FromFileName(plugin.Name);
        foreach (var (relativePath, keys) in keysByFile)
        {
            var outside = limit.Outside(modKey, keys.Select(key => FormKey.TryFactory(key, out var parsed) ? parsed : (FormKey?)null).OfType<FormKey>());
            if (outside.Count > 0) yield return new UnreadableFile(relativePath, limit.Refusal(plugin.Name, outside), outside[0].ToString());
        }
    }

    private static KnownDocument? Read(
        ISourceFiles files, string file, string relativePath, string pluginName, GameRelease release,
        List<UnreadableFile> unreadable)
    {
        byte[] bytes;
        try
        {
            bytes = DocumentText.StripUtf8Bom(files.ReadAllBytes(file));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Never exclusive owners of a file: it may vanish or lock between the listing and the
            // read. A skip and a line, and the tree stops counting as evidence a record is gone.
            unreadable.Add(new UnreadableFile(relativePath, $"Could not read '{relativePath}': {ex.Message}"));
            return null;
        }

        var text = Encoding.UTF8.GetString(bytes);
        if (SourceRepositoryLayout.IsGroupDocument(file))
        {
            return new KnownDocument(
                FormKey: null, ContentStamp(text), FormKeys: [],
                PluginSourceChecks.WhyRefused(relativePath, text, recordType: null, release), Limit: null, BelongsAt: null);
        }

        if (DocumentText.FormKeyDeclaredIn(text, file, pluginName) is not { } formKey)
        {
            unreadable.Add(new UnreadableFile(
                relativePath,
                DocumentTokens.WhyNotADocument(text) is { } error
                    ? $"'{relativePath}' is no record document: {error}"
                    : $"'{relativePath}' declares no FormKey, so the records it holds could not be validated."));
            return null;
        }

        var recordType = SourceRepositoryLayout.RecordTypeOf(relativePath, text, release);
        var refusal = PluginSourceChecks.WhyRefused(relativePath, text, recordType, release);
        var limit = refusal is null && recordType == PluginHeader.RecordType
            ? PluginFlags.LimitOf(HeaderDocument.Read(bytes, release), pluginName)
            : null;
        var belongsAt = refusal is null && recordType is not null ? PlacementOf(relativePath, text, pluginName, formKey, recordType, release) : null;
        return new KnownDocument(
            formKey, ContentStamp(text), [.. DocumentTokens.FormKeysIn(bytes, release).Select(key => key.FormKey)], refusal, limit, belongsAt);
    }

    // A flat record's file is named by its FormKey and EditorID alone, so the document says where it belongs.
    private static string? PlacementOf(
        string relativePath, string text, string pluginName, string formKey, string recordType, GameRelease release)
    {
        if (recordType == PluginHeader.RecordType || GroupFolders.For(release).FlatFolderOf(recordType) is null) return null;
        if (DocumentTokens.EditorIdIn(text) is not { WhyUnreadable: null } editorId) return null;

        var belongsAt = SourceRepositoryLayout.FlatPathFor(pluginName, recordType, formKey, editorId.EditorId, release);
        return belongsAt.Equals(relativePath, StringComparison.Ordinal) ? null : belongsAt;
    }
}
