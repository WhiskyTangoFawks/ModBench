using System.Globalization;
using System.Text.Json.Nodes;
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
    private const string GridMember = "Grid";
    private const string GridPointMember = "Point";
    private const string PositionMember = "Position";

    // An exterior cell's width in world units: Mutagen's Fallout 4 worldspace bounds and its Skyrim
    // containing-cell lookup both divide by 4096. A game without a row places no record in a grid cell.
    private static readonly Dictionary<GameCategory, float> CellWidths = new()
    {
        [GameCategory.Fallout4] = 4096f,
        [GameCategory.Skyrim] = 4096f,
    };

    /// <summary>Whether the cell's document says where it sits: interior, or at a grid. A Partial Form
    /// copy says neither.</summary>
    public static bool Says(JsonObject cell) => IsInterior(cell) || Grid(cell) != null;

    public static bool IsInterior(JsonObject cell) =>
        cell[FlagsMember] is JsonArray flags && flags.Any(flag => flag?.GetValue<string>() == InteriorFlag);

    /// <summary>The cell's grid, or null when its document carries none. The codec omits a zero point.</summary>
    public static (int X, int Y)? Grid(JsonObject cell)
    {
        if (cell[GridMember] is not JsonObject grid) return null;
        return Components(grid[GridPointMember]) is [var x, var y] ? ((int)x, (int)y) : (0, 0);
    }

    /// <summary>The grid cell a placed record's position falls in, or null when it has no position or
    /// the game has no cell width here.</summary>
    public static (int X, int Y)? GridHolding(JsonObject placed, GameRelease release) =>
        CellWidths.TryGetValue(release.ToCategory(), out var width) && Components(placed[PositionMember]) is [var x, var y, _]
            ? ((int)Math.Floor(x / width), (int)Math.Floor(y / width))
            : null;

    // The codec writes a vector as its components in English, comma-separated (ReflectedTypes.VectorText).
    private static double[]? Components(JsonNode? vector)
    {
        if (vector is not JsonValue text || !text.TryGetValue<string>(out var spelled)) return null;
        var components = new List<double>();
        foreach (var component in spelled.Split(','))
        {
            if (!double.TryParse(component.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)) return null;
            components.Add(value);
        }
        return [.. components];
    }
}
