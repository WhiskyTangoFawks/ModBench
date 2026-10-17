namespace MEditService.Codec.Game;

/// <summary>The Starfield virtual-machine-adapter facts overlaid on the reflected schema.</summary>
internal static class StarfieldVmadAnnotations
{
    /// <summary>Every adapter array xEdit declares <c>wbArrayS</c>, with its wbStructSK key members
    /// as Mutagen member names, transcribed from <c>wbDefinitionsSF1.pas</c>. INFO/PACK/SCEN fragments are
    /// plain <c>wbArray</c> ("Do NOT sort") and so absent.</summary>
    public static readonly (string TypeName, string MemberName, string[] KeyMembers)[] KeyedArrays =
    [
        ("IAVirtualMachineAdapterGetter", "Scripts", ["Name"]),
        ("IQuestFragmentAliasGetter", "Scripts", ["Name"]),
        ("IScriptEntryGetter", "Properties", ["Name"]),
        ("IScriptStructPropertyGetter", "Members", ["Name"]),
        ("IScriptEntryStructsGetter", "Members", ["Name"]),
        ("IPerkScriptFragmentsGetter", "Fragments", ["Index"]),
        ("IScriptFragmentsIndexedGetter", "Fragments", ["FragmentIndex"]),
        ("IQuestAdapterGetter", "Fragments", ["Stage", "StageIndex"]),
        ("ISceneScriptFragmentsGetter", "PhaseFragments", ["Index", "Flags"]),
        ("IQuestAdapterGetter", "Aliases", ["Property.Alias"]),
    ];

    /// <summary>xEdit's <c>wbScriptPropertyObject</c> is an Alias-or-FormID union, so an alias-bound
    /// property leaves the FormID that Mutagen types non-nullable unset.</summary>
    public static readonly (string TypeName, string MemberName)[] PermittedNullFormLinks =
    [
        ("IScriptObjectPropertyGetter", "Object"),
    ];
}
