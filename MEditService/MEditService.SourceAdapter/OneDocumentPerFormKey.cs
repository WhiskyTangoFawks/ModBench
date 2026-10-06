namespace MEditService.SourceAdapter;

/// <summary>A FormKey two documents hold, as their own record or as an embedded child, is neither's
/// (ADR-0006).</summary>
internal sealed class OneDocumentPerFormKey(string modFolder)
{
    private readonly Dictionary<string, List<string>> _holders = new(StringComparer.Ordinal);

    /// <summary>Every FormKey more than one document holds.</summary>
    internal IReadOnlyList<ClaimedFormKey> Claimed =>
        [.. _holders.Where(held => held.Value.Count > 1).Select(held => new ClaimedFormKey(held.Key, [.. held.Value]))];

    /// <summary>Records that <paramref name="document"/> holds <paramref name="formKey"/>.</summary>
    internal void Hold(string formKey, string document)
    {
        var relativePath = Path.GetRelativePath(modFolder, document);
        if (!_holders.TryGetValue(formKey, out var holders)) _holders[formKey] = holders = [];
        if (!holders.Contains(relativePath, StringComparer.Ordinal)) holders.Add(relativePath);
    }

    /// <summary><see cref="Hold"/>, throwing when another document already holds
    /// <paramref name="formKey"/>.</summary>
    internal void Claim(string formKey, string document)
    {
        Hold(formKey, document);
        if (_holders[formKey] is { Count: > 1 } holders)
            throw new AmbiguousSourceUnitException(new ClaimedFormKey(formKey, [.. holders]));
    }

    /// <summary>The one document of <paramref name="documents"/>, null for none, and a throw for
    /// more.</summary>
    internal static string? TheOne(IReadOnlyList<string> documents, string formKey, string modFolder) =>
        documents.Count switch
        {
            0 => null,
            1 => documents[0],
            _ => throw new AmbiguousSourceUnitException(
                new ClaimedFormKey(formKey, [.. documents.Select(d => Path.GetRelativePath(modFolder, d))])),
        };
}
