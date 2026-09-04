namespace MEditService.Core.Records;

/// <summary>One child's parent slot for the container relationships the placement tables omit;
/// additive, never a copy. <see cref="SlotIndex"/> is the real GRUP position. Effective only: every
/// write path re-derives it.</summary>
public readonly record struct ContainerChildRow(
    string ChildFormKey, string ParentFormKey, string ParentRecordType, string SlotName, int SlotIndex);
// Rejected: having every reader existence-check against records instead, which would make "these
// tables track Effective" a documented falsehood.
