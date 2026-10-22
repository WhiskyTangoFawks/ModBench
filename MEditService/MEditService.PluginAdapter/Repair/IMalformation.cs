using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

/// <summary>One way another tool writes a record that the Creation Kit never does (ADR-0006): the
/// records it reads, what in their subrecords proves it, and the edits that repair it.</summary>
internal interface IMalformation
{
    bool Reads(string recordType, CreationKitShapes shapes);

    IEnumerable<Malformed> Detect(InspectedRecord record);
}

/// <summary>A record's subrecords as the game's Creation Kit shapes judge them.</summary>
internal sealed record InspectedRecord(string Type, IReadOnlyList<Subrecord> Subrecords, CreationKitShapes Shapes);

/// <summary>One malformation in one record. A null <paramref name="Repair"/> is one no byte operation answers.</summary>
internal sealed record Malformed(string DefectClass, string Message, IReadOnlyList<SubrecordEdit>? Repair);
