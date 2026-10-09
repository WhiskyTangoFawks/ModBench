using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

// What the documents under one plugin's source root declare, from one token scan: the record at
// each one's root, and the children it carries inline. A scan for one key reads only the
// documents that may hold it.
internal sealed class TreeScan
{
    // The document a child sits inside: its file, the record at its root, and that record's type
    // where the path decides it — null means the document names its own.
    internal readonly record struct OwnerDocument(string FullPath, string FormKey, string? RecordType);

    private readonly record struct Holders(List<string> Declaring, List<OwnerDocument> Carrying);

    private sealed record DocumentKeys(byte[] Bytes, HashSet<string> AtRoot, HashSet<string> Embedded);

    private readonly string _sourceRoot;
    private readonly GameRelease _release;
    private readonly ISourceFiles _files;
    private readonly byte[]? _onlyKey;
    private Dictionary<string, List<OwnerDocument>> _byChild = new(StringComparer.Ordinal);
    private Dictionary<string, List<string>> _byRoot = new(StringComparer.Ordinal);
    private bool _rescanned;
    private readonly Dictionary<string, DocumentKeys> _keysByDocument = new(StringComparer.Ordinal);

    internal TreeScan(string sourceRoot, GameRelease release, string? onlyKey, IEnumerable<string> listed, ISourceFiles files)
    {
        (_sourceRoot, _release, _files) = (sourceRoot, release, files);
        _onlyKey = onlyKey is null ? null : System.Text.Encoding.UTF8.GetBytes(onlyKey);
        Scan(listed);
    }

    internal OwnerDocument? DocumentHolding(string formKey)
    {
        var carrying = HoldersOf(formKey).Carrying;
        return OneDocumentPerFormKey.TheOne([.. carrying.Select(owner => owner.FullPath)], formKey, ModFolder) is { } path
            ? carrying.Single(owner => owner.FullPath == path)
            : null;
    }

    internal List<string> DocumentsDeclaring(string formKey) => HoldersOf(formKey).Declaring;

    // Every answer is checked against the document's current text, so a stale entry reads as
    // absence. A key no document bears out, at its root or inline, is read again once per scan.
    private Holders HoldersOf(string formKey)
    {
        var holders = BorneOut(formKey);
        if (holders.Declaring.Count > 0 || holders.Carrying.Count > 0 || _rescanned) return holders;
        _rescanned = true;
        Scan(_files.DirectoryExists(_sourceRoot) ? _files.FilesIn(_sourceRoot, "*.json", SearchOption.AllDirectories) : []);
        return BorneOut(formKey);
    }

    private Holders BorneOut(string formKey) => new(
        [.. _byRoot.GetValueOrDefault(formKey, []).Where(document => KeysOf(document)?.AtRoot.Contains(formKey) == true)],
        [.. _byChild.GetValueOrDefault(formKey, []).Where(owner => KeysOf(owner.FullPath)?.Embedded.Contains(formKey) == true)]);

    private string ModFolder => PathShape.DirectoryOf(PathShape.DirectoryOf(_sourceRoot));

    // One owner is verified for each of its many children, so its tokens are reused while its
    // bytes are unchanged.
    private DocumentKeys? KeysOf(string documentPath)
    {
        if (DocumentText.BytesOrNull(_files, documentPath) is not { } bytes) return null;
        if (_keysByDocument.TryGetValue(documentPath, out var known) && known.Bytes.AsSpan().SequenceEqual(bytes))
            return known;

        var keys = DocumentTokens.FormKeysIn(bytes, _release);
        return _keysByDocument[documentPath] = new DocumentKeys(
            bytes,
            [.. keys.Where(k => k.AtRoot).Select(k => k.FormKey)],
            [.. keys.Where(k => k.InAnEmbedSlot).Select(k => k.FormKey)]);
    }

    private void Scan(IEnumerable<string> listed)
    {
        var byChild = new Dictionary<string, List<OwnerDocument>>(StringComparer.Ordinal);
        var byRoot = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var documentPath in listed)
        {
            if (SourceRepositoryLayout.CarriesNoRecord(documentPath)) continue;
            if (DocumentText.BytesOrNull(_files, documentPath) is not { } bytes) continue;
            if (_onlyKey is { } key && !MaySpell(bytes, key)) continue;

            var keys = DocumentTokens.FormKeysIn(bytes, _release);
            if (keys.FirstOrDefault(k => k.AtRoot).FormKey is not { } root) continue;

            if (!byRoot.TryGetValue(root, out var declaring)) byRoot[root] = declaring = [];
            declaring.Add(documentPath);

            // A null type is an answer, not a skip: a path-ambiguous group's documents name
            // their own type, and dropping them leaves every child they carry unlocatable.
            var recordType = SourceRepositoryLayout.RecordTypeOf(Path.GetRelativePath(ModFolder, documentPath), _release);

            var owner = new OwnerDocument(documentPath, root, recordType);
            foreach (var (childFormKey, _, inAnEmbedSlot) in keys)
            {
                if (!inAnEmbedSlot) continue;
                if (!byChild.TryGetValue(childFormKey, out var owners)) byChild[childFormKey] = owners = [];
                owners.Add(owner);
            }
        }
        (_byChild, _byRoot) = (byChild, byRoot);
    }

    // JSON spells a FormKey other than literally only through a \u escape: no plugin's file name
    // holds a quote, a backslash, a slash or a control character, the only others it escapes.
    private static bool MaySpell(byte[] document, byte[] formKey) =>
        document.AsSpan().IndexOf(formKey) >= 0 || document.AsSpan().IndexOf(@"\u"u8) >= 0;
}
