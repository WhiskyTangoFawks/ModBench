# Upstream issue draft — Mutagen

**Not filed.** Drafted for the maintainer to take to https://github.com/Mutagen-Modding/Mutagen.
Referenced from `MEditService.Core/Edits/RecordEditService.ComputeReferencerRewrites` and
`RecordEditRefusal.ReferenceRemapIncomplete`, which compensate for it.

---

## Title

`ScriptStructListProperty.RemapLinks` and `EnumerateFormLinks` never descend into `Structs`, so
VMAD `ArrayOfStruct` script properties are invisible to link remapping

## Affected

- `Mutagen.Bethesda.Fallout4` — observed on **0.53.1**; the generated source is unchanged on
  `dev` as of commit `c4bdf427eb06541aa22633ce98cfc591cef3bb30` (2026-07-09).
- `Mutagen.Bethesda.Starfield` — the same generated file exists there
  (`Records/Common Subrecords/ScriptStructListProperty_Generated.cs`) with the same shape.

## Summary

A VMAD script property of type `ArrayOfStruct` is modelled as `ScriptStructListProperty`, whose
`Structs` is an `ExtendedList<ScriptEntryStructs>`; each `ScriptEntryStructs` has `Members`, which
can contain `ScriptObjectProperty` entries holding real `FormLink`s.

`ScriptStructListPropertySetterCommon.RemapLinks` is generated with **only** the base call and no
walk of `Structs`, so those FormLinks are never remapped. `ScriptStructListPropertyCommon.
EnumerateFormLinks` has the same omission, so they are also never enumerated.

The singular sibling `ScriptStructProperty` **does** walk its `Members`, and the list sibling
`ScriptObjectListProperty` **does** walk its `Objects` — which is what makes this look like a
codegen omission on the list-of-structs case specifically rather than a deliberate exclusion.

## The generated code

`Mutagen.Bethesda.Fallout4/Records/Common Subrecords/ScriptStructListProperty_Generated.cs`, in
`ScriptStructListPropertySetterCommon` (line 735 at the commit above):

```csharp
public void RemapLinks(IScriptStructListProperty obj, IReadOnlyDictionary<FormKey, FormKey> mapping)
{
    base.RemapLinks(obj, mapping);
}
```

…and in `ScriptStructListPropertyCommon` (line 923):

```csharp
public IEnumerable<IFormLinkGetter> EnumerateFormLinks(IScriptStructListPropertyGetter obj, bool iterateNestedRecords = true)
{
    foreach (var item in base.EnumerateFormLinks(obj, iterateNestedRecords))
    {
        yield return item;
    }
    yield break;
}
```

Compare `ScriptStructProperty_Generated.cs` line 735 — the singular case, which is correct:

```csharp
public void RemapLinks(IScriptStructProperty obj, IReadOnlyDictionary<FormKey, FormKey> mapping)
{
    base.RemapLinks(obj, mapping);
    obj.Members.RemapLinks(mapping);
}
```

…and `ScriptObjectListProperty_Generated.cs` line 742 — the other list case, also correct:

```csharp
public void RemapLinks(IScriptObjectListProperty obj, IReadOnlyDictionary<FormKey, FormKey> mapping)
{
    base.RemapLinks(obj, mapping);
    obj.Objects.RemapLinks(mapping);
}
```

`ScriptEntryStructs_Generated.cs` line 757 already has a working `RemapLinks` that walks `Members`,
so the fix is one missing `obj.Structs.RemapLinks(mapping);` (and the matching enumerate), not new
plumbing.

## Reproduction

```csharp
var mod = new Fallout4Mod(ModKey.FromFileName("Repro.esp"), Fallout4Release.Fallout4);
var race = mod.Races.AddNew("SomeRace");
var npc = mod.Npcs.AddNew("SomeNpc");

var structs = new ScriptStructListProperty { Name = "Slots" };
var entry = new ScriptEntryStructs();
var member = new ScriptObjectProperty { Name = "Target" };
member.Object.SetTo(race);
entry.Members.Add(member);
structs.Structs.Add(entry);

var script = new ScriptEntry { Name = "SomeScript" };
script.Properties.Add(structs);
npc.VirtualMachineAdapter = new Npc.VirtualMachineAdapter();
npc.VirtualMachineAdapter.Scripts.Add(script);

var moved = FormKey.Factory("900000:Repro.esp");
((IFormLinkContainer)npc).RemapLinks(new Dictionary<FormKey, FormKey> { [race.FormKey] = moved });

// Expected: the struct member's Object now points at `moved`.
// Actual:   it still points at race.FormKey.
Assert.Equal(moved, structs.Structs[0].Members[0].As<ScriptObjectProperty>().Object.FormKey);

// Same omission on the read side:
Assert.Contains(race.FormKey, ((IFormLinkContainerGetter)npc).EnumerateFormLinks().Select(l => l.FormKey));
```

## Why it matters downstream

Any tool doing a FormKey remap over a whole load order — Mutagen's own compactor, and Modbench's
renumber cascade — silently leaves these links pointing at the old FormKey while reporting success.
The record is written out half-remapped and the link goes dangling. It cannot even be detected via
`EnumerateFormLinks`, because that has the identical gap; a consumer has to walk `Structs` itself.

## Suggested fix

In the generator, treat `ScriptStructListProperty.Structs` the same as
`ScriptObjectListProperty.Objects` and `ScriptStructProperty.Members`, so the generated members
become:

```csharp
public void RemapLinks(IScriptStructListProperty obj, IReadOnlyDictionary<FormKey, FormKey> mapping)
{
    base.RemapLinks(obj, mapping);
    obj.Structs.RemapLinks(mapping);
}
```
