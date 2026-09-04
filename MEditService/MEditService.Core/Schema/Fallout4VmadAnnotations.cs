namespace MEditService.Core.Schema;

/// <summary>
/// The Fallout 4 virtual-machine-adapter facts <see cref="SchemaAnnotations"/> overlays on the
/// reflected schema. Kept in its own file for the same reason
/// <see cref="Fallout4ConditionAnnotations"/> is: <see cref="SchemaAnnotations"/> stays game-neutral
/// and the reflector never learns a game.
/// </summary>
internal static class Fallout4VmadAnnotations
{
    /// <summary>
    /// Every adapter array xEdit declares <c>wbArrayS</c> — sorted, with a sort key read off the
    /// element — paired with the element member(s) that key is, in wire (snake_case) names.
    /// Transcribed from <c>wbDefinitionsFO4.pas</c>'s own <c>wbStructSK</c> indices, which is where
    /// the game's own ordering lives:
    /// <list type="bullet">
    /// <item><c>wbVMADScripts</c> (:3978) and <c>Alias Scripts</c> (:4102) — <c>wbArrayS</c> over
    /// <c>wbScriptEntry</c>, <c>wbStructSK([0])</c> = ScriptName.</item>
    /// <item><c>wbScriptProperties</c> (:3917) and <c>wbScriptPropertyStruct</c>'s members (:3850) —
    /// <c>wbArrayS</c>, <c>wbStructSK([0])</c> = propertyName / memberName.</item>
    /// <item>PERK <c>Fragments</c> (:4053) — <c>wbArrayS</c>, <c>wbStructSK([0])</c> = Fragment Index.</item>
    /// <item>QUST <c>Fragments</c> (:4085) — <c>wbArrayS</c>, <c>wbStructSK([0, 1])</c> = Quest Stage
    /// then Quest Stage Index. Mutagen names the pair <c>Stage</c>/<c>StageIndex</c>; there is no
    /// single "index" member.</item>
    /// <item>SCEN <c>Phase Fragments</c> (:4139) — <c>wbArrayS</c>, <c>wbStructSK([1, 0])</c> = Phase
    /// Index then Phase Flag, in that order.</item>
    /// <item>QUST <c>Aliases</c> (:4098) — <c>wbArrayS</c>, <c>wbStructSK([0])</c> = the alias's own
    /// Object property, whose alias number is what distinguishes one alias binding from another.</item>
    /// </list>
    ///
    /// <para>The arrays xEdit declares plain <c>wbArray</c> are deliberately absent, and each
    /// absence is a fact rather than an omission: INFO/PACK/SCEN <c>Fragments</c> carry
    /// "<c>// Do NOT sort, ordered OnBegin, OnEnd</c>" in the definitions themselves, an
    /// array-of-struct property's instances (:3907 <c>{17}</c>) are positional, and a scalar-array
    /// property's elements have no key member at all.</para>
    /// </summary>
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

    /// <summary>
    /// A script object binding whose FormID is unset because the binding is by alias instead —
    /// xEdit's <c>wbScriptPropertyObject</c> (<c>wbDefinitionsFO4.pas:3824</c>) is a union of an
    /// Alias and a FormID, and its Alias member carries <c>SetDefaultEditValue('None')</c>: an
    /// object property that names an alias leaves the FormID null, and so does a quest fragment
    /// alias binding, which is a bare <c>wbScriptPropertyObject</c> of its own
    /// (<c>:4099</c>). Mutagen types both as a non-nullable <c>IFormLink</c>, so without this row
    /// reading such a record and sending it straight back is refused as a dangling reference.
    /// </summary>
    public static readonly (string TypeName, string MemberName)[] PermittedNullFormLinks =
    [
        ("IScriptObjectPropertyGetter", "Object"),
    ];
}
