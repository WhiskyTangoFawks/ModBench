using System.Text;

namespace MEditService.Codec.Schema;

/// <summary>One hop of a path into a document: a member by name, or else an element by position.</summary>
public readonly record struct DocumentHop(string? Member, int? Index)
{
    public static string Spell(IEnumerable<DocumentHop> path)
    {
        var sb = new StringBuilder();
        foreach (var hop in path)
        {
            if (hop.Member is { } member)
            {
                if (sb.Length > 0) sb.Append('.');
                sb.Append(member);
            }
            else
            {
                sb.Append('[').Append(hop.Index).Append(']');
            }
        }
        return sb.ToString();
    }

    internal string RequireMember() =>
        Member ?? throw new InvalidOperationException("Expected a member hop to carry a name.");

    internal int RequireIndex() =>
        Index ?? throw new InvalidOperationException("Expected an index hop to carry a position.");
}

public enum EditOp
{
    Set,
    Add,
    Remove,
    Move,
}
