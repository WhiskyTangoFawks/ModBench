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

/// <summary>What is wrong with a file of a plugin's tree that the tree still reads: compile refuses or warns of
/// it, and the FormKey it concerns when one is known.</summary>
public sealed record FileProblem(string SourceRelativePath, string Message, string? FormKey = null);

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
/// file that is no document; each FormKey declared twice; each file read unsaved; each problem of a file
/// read.</summary>
public sealed record RecordStamps(
    IReadOnlyDictionary<string, string> ByFormKey, IReadOnlyList<UnreadableFile> Unreadable,
    IReadOnlyList<ClaimedFormKey> Claimed, IReadOnlySet<string> Unsaved, IReadOnlyList<FileProblem> Problems)
{
    /// <summary>Equal when the same documents carry the same stamps, and the same files could not be
    /// read, claim one FormKey, were read unsaved or carry a problem.</summary>
    public bool Equals(RecordStamps? other) =>
        other is not null
        && ByFormKey.Count == other.ByFormKey.Count
        && ByFormKey.All(stamp => other.ByFormKey.TryGetValue(stamp.Key, out var theirs) && theirs == stamp.Value)
        && Unreadable.SequenceEqual(other.Unreadable)
        && Claimed.SequenceEqual(other.Claimed)
        && Unsaved.SetEquals(other.Unsaved)
        && Problems.SequenceEqual(other.Problems);

    /// <summary>Each file that does not read was read unsaved, and so was every document but one of
    /// each FormKey claimed more than once.</summary>
    public bool StoppedOnlyByUnsavedText =>
        (Unreadable.Count > 0 || Claimed.Count > 0)
        && Unreadable.All(file => Unsaved.Contains(file.SourceRelativePath))
        && Claimed.All(claim => claim.Documents.Count(document => !Unsaved.Contains(document)) <= 1);

    public override int GetHashCode() => ByFormKey.Count;
}

/// <summary>A record's content stamp: what the record index remembers of a document, and what the tree is
/// asked against (ADR-0003). A file is remembered once <paramref name="time"/> settles its stamp.</summary>
internal sealed class TreeStamps(TimeProvider time)
{
    private readonly ConcurrentDictionary<string, StampGatedMemo<KnownDocument>> _known = new(StringComparer.Ordinal);

    private sealed record KnownDocument(
        string? FormKey, string Content, IReadOnlyList<string> FormKeys, string? Refusal, FormIdLimit? Limit, string? BelongsAt);

    internal static string ContentStamp(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    internal RecordStamps StampsOf(string sourceFolder, PluginAddress plugin, GameRelease release, ISourceFiles files)
    {
        var unreadable = new List<UnreadableFile>();
        var holders = new OneDocumentPerFormKey(sourceFolder);
        var stamps = new Dictionary<string, string>(StringComparer.Ordinal);
        var unsaved = new HashSet<string>(StringComparer.Ordinal);

        var root = SourceRepositoryLayout.RootIn(sourceFolder, plugin.Name);
        foreach (var gone in _known.Keys.Where(tree => !Directory.Exists(tree))) _known.TryRemove(gone, out _);
        var known = _known.GetOrAdd(root, _ => new StampGatedMemo<KnownDocument>(time));
        var listed = new HashSet<string>(StringComparer.Ordinal);
        var problems = new List<FileProblem>();
        var misplaced = new List<FileProblem>();
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
                    if (document.Refusal is { } fault) problems.Add(new FileProblem(relativePath, fault));
                    continue;
                }
                holders.Hold(formKey, file);
                stamps[formKey] = document.Content;
                keysByFile[relativePath] = document.FormKeys;
                limit ??= document.Limit;
                if (document.BelongsAt is { } belongsAt) misplaced.Add(new FileProblem(relativePath, new MisplacedFile(formKey, relativePath, belongsAt).Message, formKey));
                if (document.Refusal is { } refusal) problems.Add(new FileProblem(relativePath, refusal, formKey));
            }
        }

        known.Retain(listed);
        var claimedDocuments = holders.Claimed.SelectMany(claim => claim.Documents).ToHashSet(StringComparer.Ordinal);
        problems.AddRange(misplaced.Where(file => !claimedDocuments.Contains(file.SourceRelativePath)));
        if (limit is not null) problems.AddRange(OutsideTheLimit(limit, plugin, keysByFile));
        return new RecordStamps(stamps, unreadable, holders.Claimed, unsaved, problems);
    }

    private static IEnumerable<FileProblem> OutsideTheLimit(
        FormIdLimit limit, PluginAddress plugin, Dictionary<string, IReadOnlyList<string>> keysByFile)
    {
        var modKey = ModKey.FromFileName(plugin.Name);
        foreach (var (relativePath, keys) in keysByFile)
        {
            var outside = limit.Outside(modKey, keys.Select(key => FormKey.TryFactory(key, out var parsed) ? parsed : (FormKey?)null).OfType<FormKey>());
            if (outside.Count > 0) yield return new FileProblem(relativePath, limit.Refusal(plugin.Name, outside), outside[0].ToString());
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
                    : $"'{relativePath}' {DocumentText.WhyNoFormKey(text)}, so the records it holds could not be validated."));
            return null;
        }

        var recordType = SourceRepositoryLayout.RecordTypeOf(relativePath, text, release);
        var refusal = PluginSourceChecks.WhyRefused(relativePath, text, recordType, release);
        var limit = refusal is null && recordType == PluginHeader.RecordType
            ? PluginFlags.LimitOf(HeaderDocument.Read(bytes, release), pluginName)
            : null;
        var belongsAt = refusal is null && recordType is not null ? PluginSourceChecks.LayoutPathOf(relativePath, text, pluginName, formKey, recordType, release) : null;
        return new KnownDocument(
            formKey, ContentStamp(text), [.. DocumentTokens.FormKeysIn(bytes, release).Select(key => key.FormKey)], refusal, limit, belongsAt);
    }
}
