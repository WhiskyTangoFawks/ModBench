using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>What a cell's document and its placed records' documents say about where they sit, by the
/// names of Mutagen's Cell and Worldspace members.</summary>
public static class PlacedCell
{
    /// <summary>The worldspace member holding its persistent cell.</summary>
    public const string WorldspacePersistentCellMember = "TopCell";

    private const string FlagsMember = "Flags";
    private const string InteriorFlag = "IsInteriorCell";
    /// <summary>The cell grid's member holding its point.</summary>
    public const string GridPointMember = "Point";
    private const string PositionMember = "Position";

    /// <summary>Whether the cell's document says where it sits: interior, or at a grid. A Partial Form
    /// copy says neither.</summary>
    public static bool Says(Document cell) => IsInterior(cell) || cell.Grid != null;

    /// <summary>The copy that says where the cell sits: its own, or else its nearest copy to the left, which
    /// xEdit reads as the highest override visible to the file. Null when neither says.</summary>
    public static Document? SaidBy(Document cell, string? copyOnTheLeft)
    {
        if (Says(cell)) return cell;
        return copyOnTheLeft is { } text ? Document.Parse(text) : null;
    }

    public static Document MarkedInterior(Document cell) => cell.Edited(root => root[FlagsMember] = new JsonArray(InteriorFlag));

    public static bool IsInterior(Document cell) =>
        cell.At(FlagsMember) is { ValueKind: JsonValueKind.Array } flags
        && flags.EnumerateArray().Any(flag => flag.GetString() == InteriorFlag);

    /// <summary>The cell at grid (<paramref name="x"/>, <paramref name="y"/>), its grid member as the codec
    /// writes it.</summary>
    public static Document WithGrid(Document cell, int x, int y) =>
        cell.Edited(root => root[RecordTypes.CellGridMember] =
            (x, y) == (0, 0) ? new JsonObject() : new JsonObject { [GridPointMember] = ReflectedTypes.VectorText(new { X = x, Y = y }) });

    /// <summary>The grid cell a placed record's position falls in, or null when it has no position or
    /// the game has no cell width here.</summary>
    public static (int X, int Y)? GridHolding(Document placed, GameRelease release) =>
        SchemaAnnotations.For(release.ToCategory()).ExteriorCellWidth is { } width
        && Components(placed.StringAt(PositionMember)) is [var x, var y, _]
            ? ((int)Math.Floor(x / width), (int)Math.Floor(y / width))
            : null;

    /// <summary>What xEdit creates in <paramref name="group"/>: persistent in the persistent group, and in the
    /// temporary group of a cell with a grid, at its centre. False, changing nothing, where the game's cell width is unknown.</summary>
    public static bool TryAsCreatedIn(
        Document placed, string group, Document cell, GameRelease release, out Document created, [NotNullWhen(false)] out string? refusal)
    {
        (created, refusal) = (placed, null);
        if (group == PersistentFlag.PersistentGroup)
        {
            created = placed.With(PersistentFlag.Bit, RecordHeaderFlags.Member);
            return true;
        }
        if (group != PersistentFlag.TemporaryGroup || cell.Grid is not (int x, int y)) return true;
        if (SchemaAnnotations.For(release.ToCategory()).ExteriorCellWidth is not { } width)
        {
            refusal = $"{cell.StringAt(RecordMembers.FormKey)} has a grid, and mEdit knows no cell width for {release} to place a new reference at its centre.";
            return false;
        }
        var position = ReflectedTypes.VectorText(new { X = (x + 0.5f) * width, Y = (y + 0.5f) * width, Z = 0f });
        created = placed.Edited(root => root[PositionMember] = position);
        return true;
    }

    // The codec writes a vector as its components in English, comma-separated (ReflectedTypes.VectorText).
    internal static double[]? Components(string? spelled)
    {
        if (spelled is null) return null;
        var components = new List<double>();
        foreach (var component in spelled.Split(','))
        {
            if (!double.TryParse(component.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)) return null;
            components.Add(value);
        }
        return [.. components];
    }
}
