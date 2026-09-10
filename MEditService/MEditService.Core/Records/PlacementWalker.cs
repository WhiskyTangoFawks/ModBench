using System.Globalization;
using System.Text.Json;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;

namespace MEditService.Core.Records;

public readonly record struct PlacementRow(
    string FormKey, string ParentCell, string PlacementGroup, float? PosX, float? PosY, float? PosZ);

public readonly record struct CellLocationRow(
    string CellFormKey, string? ParentWorldspace,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? GridX, int? GridY, bool IsInterior);

/// <summary>The worldspace-tree side tables (ADR-0023) read off documents: a cell's grid and a
/// placed object's position out of their own text, the block coordinates out of the structure
/// handed over beside them.</summary>
internal static class PlacementWalker
{
    private static readonly string GridPointPath = $"{RecordTypeDispatch.CellGridMember}.Point";

    private const string PositionMember = "Position";

    /// <summary>The grid is null only where the document carries no grid at all, which is a
    /// worldspace's top cell; a grid the codec wrote empty is the origin, not an absence.</summary>
    internal static CellLocationRow CellLocation(
        string cellFormKey, JsonElement cellDocument, CellStructure structure)
    {
        var (gridX, gridY) = Grid(cellDocument);

        return new CellLocationRow(
            cellFormKey, structure.ParentWorldspace,
            structure.BlockX, structure.BlockY, structure.SubX, structure.SubY,
            gridX, gridY, structure.IsInterior);
    }

    /// <summary>A placed record's position is a non-nullable vector, so a document omitting it places
    /// the record at the origin rather than nowhere.</summary>
    internal static PlacementRow Placement(
        string placedFormKey, JsonElement placedDocument, string parentCellFormKey, string placementGroup)
    {
        var position = Components(placedDocument, PositionMember);
        return position is { Length: >= 3 }
            ? new PlacementRow(
                placedFormKey, parentCellFormKey, placementGroup,
                Float(position[0]), Float(position[1]), Float(position[2]))
            : new PlacementRow(placedFormKey, parentCellFormKey, placementGroup, 0f, 0f, 0f);
    }

    private static (int? X, int? Y) Grid(JsonElement cellDocument)
    {
        if (DocumentNodes.At(cellDocument, RecordTypeDispatch.CellGridMember) is null) return (null, null);

        return Components(cellDocument, GridPointPath) is { Length: >= 2 } point
            ? (Int(point[0]), Int(point[1]))
            : (0, 0);
    }

    // The codec writes a vector as its components in English, comma-separated (ReflectedTypes.VectorText).
    private static string[]? Components(JsonElement document, string path) =>
        DocumentNodes.At(document, path) is { ValueKind: JsonValueKind.String } vector
            ? vector.GetString()!.Split(',')
            : null;

    private static int? Int(string component) =>
        int.TryParse(component.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;

    private static float? Float(string component) =>
        float.TryParse(component.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
}
