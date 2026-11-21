using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A Modbench script's records laid out where their winning copies sit. A container not given is carried in as Copy
/// as Override carries one in (ADR-0018).</summary>
internal sealed class PatchRecords(IQueries index, LoadOrderResolution resolution, ISourceAdapter source, SchemaReflector schemaReflector)
{
    internal Answer<IReadOnlyList<MadeRecord>, PatchRefused> Laid(
        string pluginName, IReadOnlyList<GivenRecord> given, GameRelease release, long version, CancellationToken cancel)
    {
        using var copies = new CopySources(resolution, new WriteSessions(source, []));
        return new Laying(index, version, copies, schemaReflector.GetSchemas(release), RecordTypes.For(release), pluginName, cancel).All(given);
    }

    private sealed class Laying(
        IQueries index, long version, CopySources copies, IReadOnlyDictionary<string, RecordTableSchema> schemas, RecordTypes types, string pluginName,
        CancellationToken cancel)
    {
        private readonly Dictionary<string, MadeRecord> _laid = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, PluginAddress?> _owners = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _containers = new(StringComparer.OrdinalIgnoreCase);

        internal Answer<IReadOnlyList<MadeRecord>, PatchRefused> All(IReadOnlyList<GivenRecord> given)
        {
            var formKeys = new List<string>(given.Count);
            for (var at = 0; at < given.Count; at++)
            {
                if (CanonicalFormKey.Of(DocumentTokens.RootStringIn(given[at].Text, RecordMembers.FormKey) ?? string.Empty) is not { } formKey)
                    return new PatchRefused.OfRecord(RecordEditRefusal.InvalidEnvelope, $"Record {at + 1} of those given names no FormKey, so it cannot be placed.");
                formKeys.Add(formKey);
            }
            if (AskOwners(formKeys) is { } notAsked) return notAsked;
            for (var at = 0; at < given.Count; at++)
            {
                if (Given(formKeys[at], given[at]) is { } refused) return refused;
            }
            while (_containers.Count > 0)
            {
                List<string> carried = [.. _containers.Where(formKey => !_laid.ContainsKey(formKey))];
                _containers.Clear();
                if (CarriedInLayer(carried) is { } refused) return refused;
            }
            return _laid.Values.ToList();
        }

        private PatchRefused? Given(string formKey, GivenRecord record)
        {
            if (_laid.ContainsKey(formKey))
            {
                return new PatchRefused.AsCompile(
                    CompileRefusal.FormKeyCollision, $"{pluginName} cannot be made: more than one record given claims the same FormKey — {formKey}.");
            }

            if (!TypeOf(formKey, record.RecordType).Holds(out var type, out var unknown)) return unknown;
            return Laid(new RecordIdentity(formKey, type, DocumentTokens.EditorIdIn(record.Text).EditorId), record.Text, _owners[formKey]);
        }

        // A record's type is the one every copy of its FormKey holds, so a type given that differs is refused.
        private Answer<string, PatchRefused> TypeOf(string formKey, string? given)
        {
            if (given is not null && (!schemas.ContainsKey(given) || given == PluginHeader.RecordType))
                return new PatchRefused.OfRecord(RecordEditRefusal.RecordTypeNotFound, $"'{given}', given for {formKey}, is no record type.");
            if (_owners[formKey] is not { } held)
            {
                return given ?? (Answer<string, PatchRefused>)new PatchRefused.OfRecord(
                    RecordEditRefusal.RecordTypeNotFound, $"{NoneHolds(formKey)}, so its record type must be given.");
            }
            if (!HeldIdentity(formKey, held, copies.Of(held)).Holds(out var identity, out var unread)) return unread;
            var type = identity.RecordType;
            return given is null || given == type
                ? type
                : new PatchRefused.OfRecord(RecordEditRefusal.InvalidEnvelope, $"{formKey} is a {type} in {held.Name}, not the {given} given.");
        }

        private PatchRefused? CarriedInLayer(IReadOnlyList<string> containers)
        {
            if (AskOwners(containers) is { } notAsked) return notAsked;
            foreach (var formKey in containers)
            {
                if (CarriedIn(formKey) is { } refused) return refused;
            }
            return null;
        }

        private PatchRefused? CarriedIn(string formKey)
        {
            if (_owners[formKey] is not { } held)
                return new PatchRefused.OfRecord(RecordEditRefusal.ContainerUnknown, $"{NoneHolds(formKey)}, which holds a record given.");
            var copy = copies.Of(held);
            var read = HeldIdentity(formKey, held, copy).Then(identity => Read(formKey, held, CarriedCopy(copy, identity)));
            if (!read.Holds(out var document, out var unread)) return unread;
            return Laid(document.Identity, document.Body, held);
        }

        private CopyRead<SourceDocument> CarriedCopy(CopySource copy, RecordIdentity container)
        {
            var release = copy.Snapshot.GameRelease;
            return RecordCopy.PartialFormCopyOf(copy, container, schemas[container.RecordType], release).Then(partialForm =>
                partialForm ?? copy.Document(container).Then<SourceDocument>(document =>
                    document with { Body = ContainerDocumentEdits.WithChildSlotsCut(document.Body, document.RecordType, release) }));
        }

        private PatchRefused? Laid(RecordIdentity identity, string text, PluginAddress? owner)
        {
            if (!Placed(identity, text, owner).Holds(out var laid, out var refused)) return refused;
            _laid[identity.FormKey] = laid;
            if ((laid.Container?.ParentFormKey ?? laid.Worldspace) is { } container) _containers.Add(container);
            return null;
        }

        private Answer<MadeRecord, PatchRefused> Placed(RecordIdentity identity, string text, PluginAddress? owner)
        {
            var isCell = types.IsCell(identity.RecordType);
            if (types.IsCreatable(identity.RecordType) && !isCell) return new MadeRecord(identity, text);

            DocumentContainment? container = null;
            string? worldspace = null;
            if (owner is { } held)
            {
                var copy = copies.Of(held);
                if (!Read(identity.FormKey, held, copy.ContainerOf(identity)).Holds(out container, out var unread)) return unread;
                if (container is null && isCell && !Read(identity.FormKey, held, copy.WorldspaceOf(identity)).Holds(out worldspace, out unread))
                    return unread;
            }

            if (container is { } slot) return new MadeRecord(identity, text, slot);
            if (!isCell)
            {
                return new PatchRefused.OfRecord(
                    RecordEditRefusal.ContainerUnknown,
                    $"No active or compiled plugin's copy of {identity.FormKey} says which container it lives in. Give it inside its container's document.");
            }
            if (worldspace is not null)
            {
                return HasGrid(text)
                    ? new MadeRecord(identity, text, Worldspace: worldspace)
                    : new PatchRefused.OfRecord(
                        RecordEditRefusal.ContainerUnknown,
                        $"{identity.FormKey} is an exterior cell of {worldspace}, and its document holds no Grid, so where it sits is unknown.");
            }
            return owner is null && HasGrid(text)
                ? new PatchRefused.OfRecord(
                    RecordEditRefusal.ContainerUnknown, $"{NoneHolds(identity.FormKey)}, an exterior cell, so which worldspace it sits in is unknown.")
                : new MadeRecord(identity, text);
        }

        private static string NoneHolds(string formKey) => $"No active plugin and no compiled plugin holds {formKey}";

        private static bool HasGrid(string text) => Document.TryRead(text, out var document, out _) && document.Grid is not null;

        private PatchRefused.OfIndex? AskOwners(IReadOnlyList<string> formKeys)
        {
            if (formKeys.Count == 0) return null;
            if (!index.GetRecordOwnersForAWrite(version, formKeys, cancel).Holds(out var owners, out var refused)) return new PatchRefused.OfIndex(refused);
            foreach (var (formKey, held) in owners) _owners[formKey] = held.Count > 0 ? held[0] : null;
            return null;
        }

        // The record index can lag a change another program made to the plugin (ADR-0003).
        private static Answer<RecordIdentity, PatchRefused> HeldIdentity(string formKey, PluginAddress owner, CopySource copy) =>
            Read(formKey, owner, copy.Identity(formKey)).Then<RecordIdentity>(identity => identity is { } held
                ? held
                : new PatchRefused.OfRecord(
                    RecordEditRefusal.RecordNotFound, $"The record index names {owner.Name} as holding {formKey}, which it does not now."));

        private static Answer<T, PatchRefused> Read<T>(string formKey, PluginAddress owner, CopyRead<T> read) =>
            read.Holds(out var value, out var unread)
                ? value
                : new PatchRefused.OfRecord(unread.Kind, $"{formKey} cannot be placed: {owner.Name}'s copy of it cannot be read: {unread.Why}");
    }
}
