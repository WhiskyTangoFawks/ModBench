using System.Text;
using System.Text.Json;

namespace MEditService.Core.Edits;

/// <summary>One hop of a write's path: a member by name, an element by position, or an element by
/// key in a keyed array (ADR-0032).</summary>
public sealed record PathHop(string Kind, string? Name = null, int? Index = null, string? Key = null)
{
    public const string MemberKind = "member";
    public const string IndexKind = "index";
    public const string KeyKind = "key";

    public static PathHop Member(string name) => new(MemberKind, Name: name);
    public static PathHop At(int index) => new(IndexKind, Index: index);
    public static PathHop ByKey(string key) => new(KeyKind, Key: key);

    /// <summary>Whether the hop names exactly what its kind needs.</summary>
    public bool IsWellFormed => Kind switch
    {
        MemberKind => Name is { Length: > 0 } && Index is null && Key is null,
        IndexKind => Index is >= 0 && Name is null && Key is null,
        KeyKind => Key is not null && Name is null && Index is null,
        _ => false,
    };
}

/// <summary>The one write shape: an operation, a path of hops and an optional value (ADR-0032).
/// <c>set</c> takes the value at the path (null clears the member); <c>add</c> appends the value, or
/// the element type's default, to the array at the path; <c>remove</c> drops the element at the
/// path; <c>move</c> places the element at the path at the index the value names.</summary>
public sealed record RecordEditEnvelope(string Op, IReadOnlyList<PathHop> Path, JsonElement? Value = null)
{
    public const string Set = "set";
    public const string Add = "add";
    public const string Remove = "remove";
    public const string Move = "move";

    /// <summary>The path as a refusal names it: <c>Conditions[0].Data.Function</c>, a key hop in
    /// brackets as its text.</summary>
    public static string Spell(IEnumerable<PathHop> path)
    {
        var sb = new StringBuilder();
        foreach (var hop in path)
        {
            switch (hop.Kind)
            {
                case PathHop.MemberKind:
                    if (sb.Length > 0) sb.Append('.');
                    sb.Append(hop.Name);
                    break;
                case PathHop.IndexKind:
                    sb.Append('[').Append(hop.Index).Append(']');
                    break;
                default:
                    sb.Append('[').Append(hop.Key).Append(']');
                    break;
            }
        }
        return sb.ToString();
    }
}
