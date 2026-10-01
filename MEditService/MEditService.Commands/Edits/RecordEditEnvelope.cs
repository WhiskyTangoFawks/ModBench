using System.Text;
using System.Text.Json;

namespace MEditService.Commands.Edits;

/// <summary>One hop of a write's path: a member by name or an element by position (ADR-0005).</summary>
public sealed record PathHop(string Kind, string? Name = null, int? Index = null)
{
    public const string MemberKind = "member";
    public const string IndexKind = "index";

    public static PathHop Member(string name) => new(MemberKind, Name: name);
    public static PathHop At(int index) => new(IndexKind, Index: index);

    /// <summary>A well-formed member hop's name — a caller's claim this hop is well-formed.</summary>
    public string RequireName() =>
        Name ?? throw new InvalidOperationException("Expected a well-formed member hop to carry a name.");

    /// <summary>A well-formed index hop's position — a caller's claim this hop is well-formed.</summary>
    public int RequireIndex() =>
        Index ?? throw new InvalidOperationException("Expected a well-formed index hop to carry a position.");
}

/// <summary>The one write shape (ADR-0005): set puts the value at the path (null clears); add
/// appends the value, or the element's default; remove drops the element; move places it at the
/// index the value names.</summary>
public sealed record RecordEditEnvelope(string Op, IReadOnlyList<PathHop> Path, JsonElement? Value = null)
{
    public const string Set = "set";
    public const string Add = "add";
    public const string Remove = "remove";
    public const string Move = "move";

    /// <summary>The path as a refusal names it: <c>Conditions[0].Data.Function</c>.</summary>
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
                default:
                    sb.Append('[').Append(hop.Index).Append(']');
                    break;
            }
        }
        return sb.ToString();
    }
}
