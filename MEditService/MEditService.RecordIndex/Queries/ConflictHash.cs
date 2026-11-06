using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Queries;

/// <summary>A copy's members as the conflict classifier compares them, hashed. A member another copy in the
/// stack templates is left out of a compare, and no hash of one copy can know it.</summary>
internal static class ConflictHash
{
    public static string Of(string body, RecordTableSchema schema, GameRelease release)
    {
        var document = Document.Parse(body);
        var templated = schema.TemplatedIn(document, _ => null, release)?.Keys.ToList() ?? [];
        var partialForm = schema.IsPartialForm(document);
        using var parsed = JsonDocument.Parse(body);
        var root = parsed.RootElement;
        var compared = new StringBuilder();
        foreach (var column in schema.RecordColumns)
        {
            var member = column.Field;
            if (column.Synthetic is not null || templated.Contains(member.Name) || !ConflictRules.TakesPart(member, partialForm)) continue;
            if (!root.TryGetProperty(column.PropertyName, out var held) || held.ValueKind == JsonValueKind.Null) continue;
            var shape = DocumentNodes.VariantFor(member, root);
            var value = ConflictClassifier.WithoutMembers(held, ConflictClassifier.MembersWithin(templated, member.Name));
            if (value is not JsonElement present || DocumentNodes.SameNode(null, present, shape, absentMeansDefault: true)) continue;
            compared.Append(member.Name).Append('=').Append(DocumentNodes.ComparedText(present, shape)).Append('\n');
        }
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(compared.ToString())));
    }
}
