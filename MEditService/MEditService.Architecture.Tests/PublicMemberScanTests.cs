using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

namespace MEditService.Architecture.Tests;

public sealed class PublicMemberScanTests
{
    [Fact]
    public void EveryPublicMember_HasACallerInAnotherProductionAssemblyOrALanguageOrFrameworkRuleThatHoldsItPublic()
    {
        var solution = ServiceProjects.SolutionDirectory();
        var assemblies = ServiceProjects.Production(solution)
            .Select(project => Assembly.Read(Path.Combine(AppContext.BaseDirectory, project + ".dll")))
            .ToList();
        var world = new World(
            [.. assemblies.SelectMany(a => a.References)],
            [.. assemblies.SelectMany(a => a.Extended)],
            [.. assemblies.SelectMany(a => a.ActivatedByDependencyInjection)]);
        var members = assemblies.SelectMany(a => a.Members).ToList();
        var exposed = Exposed(members, world);
        var uncalled = members
            .Where(m => m.IsType ? !exposed.Contains(m.Owner) : exposed.Contains(m.Owner) && !m.NeededPublic(world))
            .Select(m => m.Name)
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(
            assemblies.Count > 5 && world.Used.Count > 1000 && members.Count > 1000,
            $"The scan read {assemblies.Count} assemblies, {members.Count} public members and "
            + $"{world.Used.Count} cross-assembly references; it is reading the wrong build, so it "
            + "would pass by finding nothing.");
        Assert.True(
            uncalled.Count == 0,
            $"{uncalled.Count} public member(s) have no caller in another production assembly. Make "
            + "each one internal, or delete it if nothing calls it, and drive its tests through the "
            + "box's entry. A property System.Text.Json reads stays public on an internal type: made "
            + "internal, it drops off the wire. Public consts and enum members go unchecked, because "
            + "the compiler copies them into their readers:\n" + string.Join("\n", uncalled));
    }

    private static HashSet<Key> Exposed(List<VisibleMember> members, World world)
    {
        var exposed = members.Where(m => m.IsType && m.NeededPublic(world)).Select(m => m.Owner).ToHashSet();
        var growing = true;
        while (growing)
        {
            var before = exposed.Count;
            foreach (var member in members.Where(m => exposed.Contains(m.Owner) && (m.IsType || m.NeededPublic(world))))
                exposed.UnionWith(member.Exposes);
            growing = exposed.Count > before;
        }

        return exposed;
    }

    private sealed record Key(string Assembly, string Type, string Member, string Signature)
    {
        public static Key OfType(string assembly, string type) => new(assembly, type, string.Empty, string.Empty);
    }

    private sealed record World(HashSet<Key> Used, HashSet<Key> Extended, HashSet<Key> Activated);

    private sealed record VisibleMember(
        string Name, Key Owner, bool IsType, ImmutableArray<Key> Keys, ImmutableArray<Key> Exposes, Func<World, bool> HeldPublic)
    {
        public bool NeededPublic(World world) => Keys.Any(world.Used.Contains) || HeldPublic(world);
    }

    private sealed record Metadata(
        List<Key> References, List<Key> Extended, List<Key> ActivatedByDependencyInjection, List<VisibleMember> Members);

    private sealed class Assembly(string name, MetadataReader reader)
    {
        private const string ComposedByWebApplicationFactory = "Program";
        private const string MutagenNamespace = "Mutagen.";
        private const string MixInsTheSerializationGeneratorEmitsPublic = "MixIns";
        private const string DependencyInjection = "Microsoft.Extensions.DependencyInjection";
        private readonly SignatureNames names = new(reader, name);

        public static Metadata Read(string path)
        {
            using var pe = new PEReader(File.OpenRead(path));
            var reader = pe.GetMetadataReader();
            var assembly = new Assembly(reader.GetString(reader.GetAssemblyDefinition().Name), reader);
            return new Metadata(
                [.. assembly.References()], [.. assembly.Extended()], [.. assembly.Activated()], [.. assembly.Members()]);
        }

        private IEnumerable<Key> References()
        {
            foreach (var handle in reader.TypeReferences)
            {
                if (names.Owner(handle) is { } owner)
                    yield return Key.OfType(owner, names.Of(handle));
            }

            foreach (var handle in reader.MemberReferences)
            {
                var member = reader.GetMemberReference(handle);
                if (Parent(member.Parent) is { } parent)
                    yield return parent with { Member = reader.GetString(member.Name), Signature = Signature(member.Signature).Text };
            }
        }

        private IEnumerable<Key> Extended() =>
            reader.TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .SelectMany(type => type.GetInterfaceImplementations()
                    .Select(i => reader.GetInterfaceImplementation(i).Interface)
                    .Append(type.BaseType))
                .Select(Parent)
                .OfType<Key>();

        private IEnumerable<Key> Activated()
        {
            foreach (var row in Enumerable.Range(1, reader.GetTableRowCount(TableIndex.MethodSpec)))
            {
                var handle = MetadataTokens.MethodSpecificationHandle(row);
                var specification = reader.GetMethodSpecification(handle);
                if (specification.Method.Kind != HandleKind.MemberReference
                    || reader.GetMemberReference((MemberReferenceHandle)specification.Method).Parent is not { Kind: HandleKind.TypeReference } parent
                    || reader.GetString(reader.GetTypeReference((TypeReferenceHandle)parent).Namespace) != DependencyInjection)
                    continue;
                var (_, arguments) = names.Collecting(() => string.Join(",", specification.DecodeSignature(names, null)));
                foreach (var argument in arguments)
                    yield return argument;
            }
        }

        private IEnumerable<VisibleMember> Members()
        {
            foreach (var handle in reader.TypeDefinitions)
            {
                var type = reader.GetTypeDefinition(handle);
                var owner = Key.OfType(name, names.Of(handle));
                if (!IsVisible(type) || IsSerializationGeneratorMixIns(type))
                    continue;
                var heldPublic = owner.Type == ComposedByWebApplicationFactory || HoldsConstantsItsReadersCopy(type);
                yield return new VisibleMember(owner.Type, owner, true, [owner], TypeExposes(type), _ => heldPublic);
                foreach (var member in Members(type, owner))
                    yield return member;
            }
        }

        private bool IsSerializationGeneratorMixIns(TypeDefinition type) =>
            type.GetDeclaringType().IsNil
            && reader.GetString(type.Namespace).StartsWith(MutagenNamespace, StringComparison.Ordinal)
            && reader.GetString(type.Name).EndsWith(MixInsTheSerializationGeneratorEmitsPublic, StringComparison.Ordinal)
            && (type.Attributes & (TypeAttributes.Abstract | TypeAttributes.Sealed)) == (TypeAttributes.Abstract | TypeAttributes.Sealed);

        private ImmutableArray<Key> TypeExposes(TypeDefinition type)
        {
            var exposes = type.GetInterfaceImplementations()
                .Select(i => reader.GetInterfaceImplementation(i).Interface)
                .Append(type.BaseType)
                .Where(h => !h.IsNil && h.Kind == HandleKind.TypeDefinition)
                .Select(h => Key.OfType(name, names.Of((TypeDefinitionHandle)h)));
            return [.. type.GetDeclaringType().IsNil ? exposes : exposes.Append(Key.OfType(name, names.Of(type.GetDeclaringType())))];
        }

        private IEnumerable<VisibleMember> Members(TypeDefinition type, Key owner)
        {
            var isInterface = (type.Attributes & TypeAttributes.Interface) != 0;
            var positional = PositionalParameters(type);
            var accessors = type.GetProperties().Select(reader.GetPropertyDefinition).SelectMany(p => Accessors(p.GetAccessors()))
                .Concat(type.GetEvents().Select(reader.GetEventDefinition).SelectMany(e => Accessors(e.GetAccessors())))
                .ToHashSet();
            bool ImplementedElsewhere(World world) => world.Extended.Contains(owner);

            foreach (var handle in type.GetMethods().Where(h => !accessors.Contains(h) && IsVisible(h)))
            {
                var method = reader.GetMethodDefinition(handle);
                var (key, exposes) = MethodKey(owner, handle);
                var methodName = reader.GetString(method.Name);
                var isConstructor = methodName == ".ctor";
                var isPrimaryConstructor = isConstructor && positional.Length > 0 && positional.SequenceEqual(ParameterNames(method));
                var held = IsCompilerGenerated(method.GetCustomAttributes())
                    || IsDispatchedTo(method.Attributes)
                    || isPrimaryConstructor
                    || IsOperatorTheLanguageDeclaresPublic(method, methodName);
                var isAbstract = (method.Attributes & MethodAttributes.Abstract) != 0;
                yield return new VisibleMember(
                    $"{owner.Type}.{methodName}({key.Signature})", owner, false, [key], exposes,
                    world => held
                        || ((isInterface || isAbstract) && ImplementedElsewhere(world))
                        || (isConstructor && world.Activated.Contains(owner)));
            }

            foreach (var property in type.GetProperties().Select(reader.GetPropertyDefinition))
            {
                var visibleAccessors = Accessors(property.GetAccessors()).Where(IsVisible).ToList();
                if (visibleAccessors.Count == 0)
                    continue;
                var keys = visibleAccessors.Select(h => MethodKey(owner, h)).ToList();
                var attributes = visibleAccessors.Select(h => reader.GetMethodDefinition(h).Attributes).ToList();
                var held = IsCompilerGenerated(property.GetCustomAttributes())
                    || positional.Contains(reader.GetString(property.Name))
                    || attributes.Any(IsDispatchedTo);
                var isAbstract = attributes.Any(a => (a & MethodAttributes.Abstract) != 0);
                yield return new VisibleMember(
                    $"{owner.Type}.{reader.GetString(property.Name)}", owner, false,
                    [.. keys.Select(k => k.Key)], [.. keys.SelectMany(k => k.Exposes)],
                    world => held || ((isInterface || isAbstract) && ImplementedElsewhere(world)));
            }

            foreach (var @event in type.GetEvents().Select(reader.GetEventDefinition))
            {
                var visibleAccessors = Accessors(@event.GetAccessors()).Where(IsVisible).ToList();
                if (visibleAccessors.Count == 0)
                    continue;
                var keys = visibleAccessors.Select(h => MethodKey(owner, h)).ToList();
                yield return new VisibleMember(
                    $"{owner.Type}.{reader.GetString(@event.Name)}", owner, false,
                    [.. keys.Select(k => k.Key)], [.. keys.SelectMany(k => k.Exposes)],
                    world => isInterface && ImplementedElsewhere(world));
            }

            foreach (var field in type.GetFields().Select(reader.GetFieldDefinition))
            {
                if (!IsVisible((MethodAttributes)(int)(field.Attributes & FieldAttributes.FieldAccessMask))
                    || IsCopiedIntoItsCallersSoNoReferenceReachesTheirMetadata(field)
                    || (field.Attributes & FieldAttributes.RTSpecialName) != 0)
                    continue;
                var fieldName = reader.GetString(field.Name);
                var (signature, exposes) = names.Collecting(() => field.DecodeSignature(names, null));
                yield return new VisibleMember(
                    $"{owner.Type}.{fieldName}", owner, false, [owner with { Member = fieldName, Signature = signature }],
                    exposes, _ => false);
            }
        }

        private static bool IsCopiedIntoItsCallersSoNoReferenceReachesTheirMetadata(FieldDefinition field) =>
            (field.Attributes & FieldAttributes.Literal) != 0;

        private bool HoldsConstantsItsReadersCopy(TypeDefinition type) =>
            !IsEnum(type)
            && type.GetFields().Select(reader.GetFieldDefinition).Any(field =>
                IsCopiedIntoItsCallersSoNoReferenceReachesTheirMetadata(field)
                && IsVisible((MethodAttributes)(int)(field.Attributes & FieldAttributes.FieldAccessMask)));

        private bool IsEnum(TypeDefinition type) =>
            type.BaseType.Kind == HandleKind.TypeReference
            && names.Of((TypeReferenceHandle)type.BaseType) == "System.Enum";

        private static IEnumerable<MethodDefinitionHandle> Accessors(PropertyAccessors accessors) =>
            new[] { accessors.Getter, accessors.Setter }.Where(h => !h.IsNil);

        private static IEnumerable<MethodDefinitionHandle> Accessors(EventAccessors accessors) =>
            new[] { accessors.Adder, accessors.Remover }.Where(h => !h.IsNil);

        private (Key Key, ImmutableArray<Key> Exposes) MethodKey(Key owner, MethodDefinitionHandle handle)
        {
            var method = reader.GetMethodDefinition(handle);
            var (text, exposes) = Signature(method.Signature);
            return (owner with { Member = reader.GetString(method.Name), Signature = text }, exposes);
        }

        private ImmutableArray<string> PositionalParameters(TypeDefinition type) =>
            [.. type.GetMethods()
                .Select(reader.GetMethodDefinition)
                .Where(m => reader.GetString(m.Name) == "Deconstruct" && IsCompilerGenerated(m.GetCustomAttributes()))
                .SelectMany(ParameterNames)];

        private IEnumerable<string> ParameterNames(MethodDefinition method) =>
            method.GetParameters()
                .Select(reader.GetParameter)
                .Where(p => p.SequenceNumber > 0)
                .Select(p => reader.GetString(p.Name));

        private bool IsCompilerGenerated(CustomAttributeHandleCollection attributes) =>
            attributes.Any(handle =>
                reader.GetCustomAttribute(handle).Constructor is { Kind: HandleKind.MemberReference } constructor
                && reader.GetMemberReference((MemberReferenceHandle)constructor).Parent is { Kind: HandleKind.TypeReference } parent
                && reader.GetString(reader.GetTypeReference((TypeReferenceHandle)parent).Name) == "CompilerGeneratedAttribute");

        private static bool IsOperatorTheLanguageDeclaresPublic(MethodDefinition method, string methodName) =>
            (method.Attributes & MethodAttributes.SpecialName) != 0 && methodName.StartsWith("op_", StringComparison.Ordinal);

        private static bool IsDispatchedTo(MethodAttributes attributes) =>
            (attributes & MethodAttributes.Virtual) != 0
            && ((attributes & MethodAttributes.NewSlot) == 0 || (attributes & MethodAttributes.Final) != 0);

        private bool IsVisible(TypeDefinition type) => (type.Attributes & TypeAttributes.VisibilityMask) switch
        {
            TypeAttributes.Public => true,
            TypeAttributes.NestedPublic or TypeAttributes.NestedFamily or TypeAttributes.NestedFamORAssem =>
                IsVisible(reader.GetTypeDefinition(type.GetDeclaringType())),
            _ => false,
        };

        private bool IsVisible(MethodDefinitionHandle handle) =>
            IsVisible(reader.GetMethodDefinition(handle).Attributes & MethodAttributes.MemberAccessMask);

        private static bool IsVisible(MethodAttributes access) =>
            access is MethodAttributes.Public or MethodAttributes.Family or MethodAttributes.FamORAssem;

        private Key? Parent(EntityHandle parent) => parent.Kind switch
        {
            HandleKind.TypeReference => names.Owner((TypeReferenceHandle)parent) is { } owner
                ? Key.OfType(owner, names.Of((TypeReferenceHandle)parent))
                : null,
            HandleKind.TypeSpecification => names.Generic((TypeSpecificationHandle)parent) is { } generic ? Parent(generic) : null,
            _ => null,
        };

        private (string Text, ImmutableArray<Key> Exposes) Signature(BlobHandle blob) => names.Collecting(() =>
        {
            var decoder = new SignatureDecoder<string, object?>(names, reader, null);
            var signature = reader.GetBlobReader(blob);
            var isField = signature.ReadSignatureHeader().Kind == SignatureKind.Field;
            signature.Reset();
            if (isField)
                return decoder.DecodeFieldSignature(ref signature);
            var method = decoder.DecodeMethodSignature(ref signature);
            return $"{method.GenericParameterCount}:{method.ReturnType}({string.Join(",", method.ParameterTypes)})";
        });
    }

    private sealed class SignatureNames(MetadataReader reader, string assembly) : ISignatureTypeProvider<string, object?>
    {
        private HashSet<Key> collected = [];

        public (string Text, ImmutableArray<Key> Types) Collecting(Func<string> decode)
        {
            collected = [];
            var text = decode();
            return (text, [.. collected]);
        }

        public string Of(TypeDefinitionHandle handle)
        {
            var type = reader.GetTypeDefinition(handle);
            var declaring = type.GetDeclaringType();
            return declaring.IsNil ? Qualified(type.Namespace, type.Name) : Of(declaring) + "/" + reader.GetString(type.Name);
        }

        public string Of(TypeReferenceHandle handle)
        {
            var type = reader.GetTypeReference(handle);
            return type.ResolutionScope.Kind == HandleKind.TypeReference
                ? Of((TypeReferenceHandle)type.ResolutionScope) + "/" + reader.GetString(type.Name)
                : Qualified(type.Namespace, type.Name);
        }

        public string? Owner(TypeReferenceHandle handle)
        {
            var scope = reader.GetTypeReference(handle).ResolutionScope;
            return scope.Kind switch
            {
                HandleKind.AssemblyReference => reader.GetString(reader.GetAssemblyReference((AssemblyReferenceHandle)scope).Name),
                HandleKind.TypeReference => Owner((TypeReferenceHandle)scope),
                _ => null,
            };
        }

        public EntityHandle? Generic(TypeSpecificationHandle handle)
        {
            var blob = reader.GetBlobReader(reader.GetTypeSpecification(handle).Signature);
            if (blob.ReadSignatureTypeCode() != SignatureTypeCode.GenericTypeInstance)
                return null;
            blob.ReadSignatureTypeCode();
            return blob.ReadTypeHandle();
        }

        private string Qualified(StringHandle ns, StringHandle name) =>
            reader.GetString(ns) is { Length: > 0 } space ? space + "." + reader.GetString(name) : reader.GetString(name);

        public string GetTypeFromDefinition(MetadataReader metadata, TypeDefinitionHandle handle, byte rawTypeKind)
        {
            var type = Of(handle);
            collected.Add(Key.OfType(assembly, type));
            return type;
        }

        public string GetTypeFromReference(MetadataReader metadata, TypeReferenceHandle handle, byte rawTypeKind)
        {
            var type = Of(handle);
            if (Owner(handle) is { } owner)
                collected.Add(Key.OfType(owner, type));
            return type;
        }

        public string GetTypeFromSpecification(MetadataReader metadata, object? context, TypeSpecificationHandle handle, byte rawTypeKind) =>
            metadata.GetTypeSpecification(handle).DecodeSignature(this, context);

        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();
        public string GetSZArrayType(string elementType) => elementType + "[]";
        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[" + new string(',', shape.Rank - 1) + "]";
        public string GetByReferenceType(string elementType) => elementType + "&";
        public string GetPointerType(string elementType) => elementType + "*";
        public string GetPinnedType(string elementType) => elementType;
        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) =>
            genericType + "<" + string.Join(",", typeArguments) + ">";
        public string GetGenericTypeParameter(object? genericContext, int index) => "!" + index;
        public string GetGenericMethodParameter(object? genericContext, int index) => "!!" + index;
        public string GetFunctionPointerType(MethodSignature<string> signature) => "fnptr";
        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) =>
            isRequired ? unmodifiedType + " modreq(" + modifier + ")" : unmodifiedType;
    }
}
