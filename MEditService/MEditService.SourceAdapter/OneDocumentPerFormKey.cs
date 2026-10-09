namespace MEditService.SourceAdapter;

/// <summary>A FormKey two documents hold, as their own record or as an embedded child, is neither's,
/// and one a document holds twice is not that document's to give either copy of (ADR-0006).</summary>
internal sealed class OneDocumentPerFormKey(string modFolder)
{
    private readonly Dictionary<string, List<string>> _holdings = new(StringComparer.Ordinal);

    /// <summary>Every FormKey held more than once.</summary>
    internal IReadOnlyList<ClaimedFormKey> Claimed =>
        [.. _holdings.Where(held => held.Value.Count > 1).Select(held => ClaimOf(held.Key, held.Value))];

    /// <summary>Records that <paramref name="document"/> holds <paramref name="formKey"/> once more.</summary>
    internal void Hold(string formKey, string document)
    {
        if (!_holdings.TryGetValue(formKey, out var holdings)) _holdings[formKey] = holdings = [];
        holdings.Add(Path.GetRelativePath(modFolder, document));
    }

    /// <summary><see cref="Hold"/>, throwing when <paramref name="formKey"/> is already held.</summary>
    internal void Claim(string formKey, string document)
    {
        Hold(formKey, document);
        if (_holdings[formKey] is { Count: > 1 } holdings)
            throw SourceStopException.Ambiguous(ClaimOf(formKey, holdings));
    }

    /// <summary>The one holding of <paramref name="holdings"/>, null for none, and a throw for
    /// more.</summary>
    internal static string? TheOne(IReadOnlyList<string> holdings, string formKey, string modFolder) =>
        holdings.Count switch
        {
            0 => null,
            1 => holdings[0],
            _ => throw SourceStopException.Ambiguous(
                ClaimOf(formKey, [.. holdings.Select(d => Path.GetRelativePath(modFolder, d))])),
        };

    private static ClaimedFormKey ClaimOf(string formKey, IEnumerable<string> holdings) =>
        new(formKey, [.. holdings.Distinct(StringComparer.Ordinal)]);
}
