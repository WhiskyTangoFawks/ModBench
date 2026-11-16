using System.Text.Json;
using DuckDB.NET.Data;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Store;

/// <summary>What a read takes from a record's document, derived once when the document is indexed (ADR-0005): the name the
/// strings language shows, and the base a placed reference names.</summary>
internal static class DerivedColumns
{
    internal readonly record struct Columns(string? FullName, string? Base);

    internal static Columns Of(string document, Language language)
    {
        var holdsName = document.Contains("\"Name\"", StringComparison.Ordinal);
        var holdsBase = document.Contains("\"Base\"", StringComparison.Ordinal);
        if (!holdsName && !holdsBase) return default;

        using var parsed = JsonDocument.Parse(document);
        var root = parsed.RootElement;
        return new Columns(
            holdsName && root.TryGetProperty("Name", out var name) ? NameIn(name, language) : null,
            holdsBase && root.TryGetProperty("Base", out var @base) && @base.ValueKind == JsonValueKind.String ? @base.GetString() : null);
    }

    private static string? NameIn(JsonElement name, Language language)
    {
        if (name.ValueKind != JsonValueKind.Object) return null;
        var text = name.TryGetProperty("Value", out var one) && one.ValueKind == JsonValueKind.String ? one.GetString() : EntryIn(name, language);
        return string.IsNullOrEmpty(text) ? null : text;
    }

    private static string? EntryIn(JsonElement name, Language language)
    {
        if (!name.TryGetProperty("Values", out var values) || values.ValueKind != JsonValueKind.Array) return null;
        foreach (var entry in values.EnumerateArray())
        {
            if (entry.TryGetProperty("Language", out var held) && held.GetString() == language.ToString()
                && entry.TryGetProperty("String", out var text) && text.ValueKind == JsonValueKind.String)
                return text.GetString();
        }
        return null;
    }

    // A source tree's document holds every language, so a move of the strings language shows another name. A binary's rows are
    // read again when the language moves.
    internal static void OfSourceTrees(DuckDBConnection connection) =>
        DuckDbSql.Execute(connection, $"""
            UPDATE mirror.records SET full_name = NULLIF({TranslatedStringSql.Resolved("body", "$.Name")}, '')
            WHERE (plugin, origin) IN (
                SELECT plugin, origin FROM {Store.PluginDerivationRelation} WHERE derived_from = '{DerivedFrom.SourceTree}')
            """);
}
