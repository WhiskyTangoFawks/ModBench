using System.Collections.Concurrent;
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

    /// <summary>The grid cell a placed record's position falls in, or null when it has no position.</summary>
    public static (int X, int Y)? GridHolding(Document placed, GameRelease release)
    {
        var width = SchemaAnnotations.For(release.ToCategory()).ExteriorCellWidth;
        return Components(placed.StringAt(PositionPath(release))) is [var x, var y, _]
            ? ((int)Math.Floor(x / width), (int)Math.Floor(y / width))
            : null;
    }

    /// <summary>What xEdit creates in <paramref name="group"/>: persistent in the persistent group, and in the
    /// temporary group of a cell with a grid, at its centre.</summary>
    public static Document AsCreatedIn(Document placed, string group, Document cell, GameRelease release)
    {
        if (group == PersistentFlag.PersistentGroup) return placed.With(PersistentFlag.Bit, RecordHeaderFlags.Member);
        if (group != PersistentFlag.TemporaryGroup || cell.Grid is not (int x, int y)) return placed;
        var width = SchemaAnnotations.For(release.ToCategory()).ExteriorCellWidth;
        var position = ReflectedTypes.VectorText(new { X = (x + 0.5f) * width, Y = (y + 0.5f) * width, Z = 0f });
        return placed.Edited(root => PositionHolding(root, release)[PositionMember] = position);
    }

    private static readonly ConcurrentDictionary<GameCategory, string?> PositionHolders = new();

    // Mutagen's placed-record aspect holds the position on the record itself, or in the one member it
    // declares to carry a position and rotation. Each game declares both aspects under these names.
    private static string? PositionHolder(GameRelease release) =>
        PositionHolders.GetOrAdd(release.ToCategory(), category =>
        {
            var types = SchemaReflector.GameModule(category)?.GetTypes() ?? [];
            Type Aspect(string name) => types.FirstOrDefault(t => t.Name == name)
                ?? throw new InvalidOperationException($"Mutagen.Bethesda.{category} declares no {name}, so mEdit finds no placed record's position.");
            var positioned = Aspect("IPositionRotationGetter");
            return Aspect("IPlacedGetter").GetProperties().FirstOrDefault(p => positioned.IsAssignableFrom(p.PropertyType))?.Name;
        });

    private static string[] PositionPath(GameRelease release) =>
        PositionHolder(release) is { } holder ? [holder, PositionMember] : [PositionMember];

    private static JsonObject PositionHolding(JsonObject root, GameRelease release)
    {
        if (PositionHolder(release) is not { } holder) return root;
        if (root[holder] is JsonObject held) return held;
        var made = new JsonObject();
        root[holder] = made;
        return made;
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
