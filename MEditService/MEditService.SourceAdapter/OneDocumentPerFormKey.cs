namespace MEditService.SourceAdapter;

/// <summary>A FormKey two documents hold, as their own record or as an embedded child, is neither's
/// (ADR-0006).</summary>
internal static class OneDocumentPerFormKey
{
    /// <summary>Records that <paramref name="document"/> holds <paramref name="formKey"/>, throwing
    /// when another document already does.</summary>
    internal static void Claim(Dictionary<string, string> holders, string formKey, string document, string modFolder)
    {
        if (holders.TryGetValue(formKey, out var earlier) && !string.Equals(earlier, document, StringComparison.Ordinal))
            throw HeldTwice(formKey, [earlier, document], modFolder);
        holders[formKey] = document;
    }

    /// <summary>The one document of <paramref name="documents"/>, null for none, and a throw for
    /// more.</summary>
    internal static string? TheOne(IReadOnlyList<string> documents, string formKey, string modFolder) =>
        documents.Count switch
        {
            0 => null,
            1 => documents[0],
            _ => throw HeldTwice(formKey, documents, modFolder),
        };

    private static AmbiguousSourceUnitException HeldTwice(string formKey, IEnumerable<string> documents, string modFolder) =>
        new(new ClaimedFormKey(formKey, [.. documents.Select(d => Path.GetRelativePath(modFolder, d))]).Message);
}
