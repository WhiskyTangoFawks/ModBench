namespace MEditService.Core.Schema;

/// <summary>The Fallout 4 virtual-machine-adapter facts overlaid on the reflected schema. Its own
/// file so <see cref="SchemaAnnotations"/> stays game-neutral.</summary>
internal static class Fallout4VmadAnnotations
{
    /// <summary>Every adapter array xEdit declares <c>wbArrayS</c>, with its wbStructSK key members
    /// as wire names, transcribed from <c>wbDefinitionsFO4.pas</c>. INFO/PACK/SCEN fragments are
    /// plain <c>wbArray</c> ("Do NOT sort") and so absent.</summary>
    public static readonly (string TypeName, string MemberName, string[] KeyMembers)[] KeyedArrays =
    [
        ("IAVirtualMachineAdapterGetter", "Scripts", ["name"]),
        ("IQuestFragmentAliasGetter", "Scripts", ["name"]),
        ("IScriptEntryGetter", "Properties", ["name"]),
        ("IScriptStructPropertyGetter", "Members", ["name"]),
        ("IScriptEntryStructsGetter", "Members", ["name"]),
        ("IPerkScriptFragmentsGetter", "Fragments", ["index"]),
        ("IQuestAdapterGetter", "Fragments", ["stage", "stage_index"]),
        ("ISceneScriptFragmentsGetter", "PhaseFragments", ["index", "flags"]),
        ("IQuestAdapterGetter", "Aliases", ["property.alias"]),
    ];

    /// <summary>xEdit's <c>wbScriptPropertyObject</c> is an Alias-or-FormID union, so an alias-bound
    /// property leaves the FormID unset. Mutagen types it non-nullable, so without this row resending
    /// the read value is refused as dangling.</summary>
    public static readonly (string TypeName, string MemberName)[] PermittedNullFormLinks =
    [
        ("IScriptObjectPropertyGetter", "Object"),
    ];
}
