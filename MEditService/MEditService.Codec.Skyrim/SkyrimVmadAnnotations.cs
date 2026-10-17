namespace MEditService.Codec.Game;

/// <summary>The Skyrim virtual-machine-adapter facts overlaid on the reflected schema.</summary>
internal static class SkyrimVmadAnnotations
{
    /// <summary>Every adapter array <c>wbDefinitionsTES5.pas</c> declares <c>wbArrayS</c>, keyed by its
    /// wbStructSK members; an alias by its object union's v2 key, the FormID then the alias.</summary>
    public static readonly (string TypeName, string MemberName, string[] KeyMembers)[] KeyedArrays =
    [
        ("IAVirtualMachineAdapterGetter", "Scripts", ["Name"]),
        ("IQuestFragmentAliasGetter", "Scripts", ["Name"]),
        ("IScriptEntryGetter", "Properties", ["Name"]),
        ("IPerkScriptFragmentsGetter", "Fragments", ["FragmentIndex"]),
        ("IQuestAdapterGetter", "Fragments", ["Stage", "StageIndex"]),
        ("ISceneScriptFragmentsGetter", "PhaseFragments", ["Index", "Flags"]),
        ("IQuestAdapterGetter", "Aliases", ["Property.Object", "Property.Alias"]),
    ];

    /// <summary>xEdit's <c>wbScriptPropertyObject</c> is an Alias-or-FormID union, so an alias-bound
    /// property leaves the FormID that Mutagen types non-nullable unset.</summary>
    public static readonly (string TypeName, string MemberName)[] PermittedNullFormLinks =
    [
        ("IScriptObjectPropertyGetter", "Object"),
    ];
}
