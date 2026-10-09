using System.Globalization;
using MEditService.Codec.Schema;

namespace MEditService.Commands.Edits;

/// <summary>One hop of a write's path: a member by name or an element by position (ADR-0005).</summary>
public sealed record PathHop(string Kind, string? Name = null, int? Index = null)
{
    public const string MemberKind = "member";
    public const string IndexKind = "index";

    /// <summary>The hop into the document this one names.</summary>
    internal DocumentHop Hop => Kind == MemberKind ? new(Name ?? "", null) : new(null, Index);
}

/// <summary>The one write shape (ADR-0005): set puts the value at the path (null clears); add
/// appends the value, or the element's default; remove drops the element; move places it at the
/// value's index.</summary>
public sealed record RecordEditEnvelope(string Op, IReadOnlyList<PathHop> Path, EditValue? Value = null)
{
    public const string Set = "set";
    public const string Add = "add";
    public const string Remove = "remove";
    public const string Move = "move";

    /// <summary>The path as a refusal names it: <c>Conditions[0].Data.Function</c>.</summary>
    public static string Spell(IEnumerable<PathHop> path) => DocumentHop.Spell(path.Select(hop => hop.Hop));
}

public enum EditValueKind { WholeNumber, Text, Other }

/// <summary>The value an edit carries: its JSON text, and what the text spells for the edits that read it
/// as an integer or a string. A number that is no integer is <see cref="EditValueKind.Other"/>.</summary>
public sealed record EditValue(EditValueKind Kind, string RawText, string? Text = null)
{
    internal long Integer => long.Parse(RawText, NumberStyles.Integer, CultureInfo.InvariantCulture);
}
