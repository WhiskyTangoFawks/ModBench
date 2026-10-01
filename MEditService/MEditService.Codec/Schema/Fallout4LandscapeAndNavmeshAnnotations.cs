namespace MEditService.Codec.Schema;

/// <summary>The Fallout 4 landscape and navmesh facts overlaid on the reflected schema. Its own file
/// so <see cref="SchemaAnnotations"/> stays game-neutral.</summary>
internal static class Fallout4LandscapeAndNavmeshAnnotations
{
    /// <summary>Every landscape and navmesh array xEdit declares <c>wbArrayS</c> or <c>wbRArrayS</c>
    /// over a wbStructSK, transcribed from <c>wbDefinitionsFO4.pas</c> (wbNVNM, NAVM, NAVI) and
    /// <c>wbDefinitionsCommon.pas</c> (wbLandLayers).</summary>
    public static readonly (string TypeName, string MemberName, string[] KeyMembers)[] KeyedArrays =
    [
        ("ILandscapeGetter", "Layers", ["Header.Quadrant", "Header.LayerNumber"]),
        ("INavmeshGeometryGetter", "DoorTriangles", ["TriangleBeforeDoor", "Door"]),
        ("INavigationMeshGetter", "PreCutMapEntries", ["Reference"]),
        ("INavigationMeshInfoMapGetter", "MapInfos", ["NavigationMesh"]),
        ("INavigationMapInfoGetter", "LinkedDoors", ["Door"]),
        ("IPreferredPathingGetter", "NavmeshTree", ["NodeIndex"]),
    ];
}
