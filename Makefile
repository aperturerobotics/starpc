# https://github.com/aperturerobotics/template

SHELL:=bash
PROTOWRAP=tools/bin/protowrap
PROTOC_GEN_GO=tools/bin/protoc-gen-go-lite
PROTOC_GEN_STARPC=tools/bin/protoc-gen-go-starpc
GOIMPORTS=tools/bin/goimports
GOFUMPT=tools/bin/gofumpt
GOLANGCI_LINT=tools/bin/golangci-lint
GO_MOD_OUTDATED=tools/bin/go-mod-outdated
GOLIST=go list -f "{{ .Dir }}" -m

export GO111MODULE=on
undefine GOARCH
undefine GOOS

all:

vendor:
	go mod vendor

$(PROTOC_GEN_GO):
	cd ./tools; \
	go build -v \
		-o ./bin/protoc-gen-go-lite \
		github.com/aperturerobotics/protobuf-go-lite/cmd/protoc-gen-go-lite

$(GOIMPORTS):
	cd ./tools; \
	go build -v \
		-o ./bin/goimports \
		golang.org/x/tools/cmd/goimports

$(GOFUMPT):
	cd ./tools; \
	go build -v \
		-o ./bin/gofumpt \
		mvdan.cc/gofumpt

$(PROTOWRAP):
	cd ./tools; \
	go build -v \
		-o ./bin/protowrap \
		github.com/aperturerobotics/goprotowrap/cmd/protowrap

$(GOLANGCI_LINT):
	cd ./tools; \
	go build -v \
		-o ./bin/golangci-lint \
		github.com/golangci/golangci-lint/v2/cmd/golangci-lint

$(GO_MOD_OUTDATED):
	cd ./tools; \
	go build -v \
		-o ./bin/go-mod-outdated \
		github.com/psampaz/go-mod-outdated

$(PROTOC_GEN_STARPC):
	cd ./tools; \
	go build -v \
		-o ./bin/protoc-gen-go-starpc \
		github.com/aperturerobotics/starpc/cmd/protoc-gen-go-starpc

node_modules:
	yarn install

.PHONY: genproto
genproto: vendor node_modules $(GOIMPORTS) $(PROTOWRAP) $(PROTOC_GEN_GO) $(PROTOC_GEN_STARPC)
	shopt -s globstar; \
	set -eo pipefail; \
	export PROTOBUF_GO_TYPES_PKG=github.com/aperturerobotics/protobuf-go-lite/types; \
	export PROJECT=$$(go list -m); \
	export PATH=$$(pwd)/tools/bin:$${PATH}; \
	export OUT=./vendor; \
	mkdir -p $${OUT}/$$(dirname $${PROJECT}); \
	rm ./vendor/$${PROJECT} || true; \
	ln -s $$(pwd) ./vendor/$${PROJECT} ; \
	protogen() { \
		PROTO_FILES=$$(git ls-files "$$1"); \
		$(PROTOWRAP) \
			-I $${OUT} \
			--plugin=./node_modules/.bin/protoc-gen-es-lite \
			--plugin=./cmd/protoc-gen-es-starpc/dev/protoc-gen-es-starpc \
			--go-lite_out=$${OUT} \
			--go-lite_opt=features=marshal+unmarshal+size+equal+json+clone+text \
			--es-lite_out=$${OUT} \
			--es-lite_opt target=ts \
			--es-lite_opt ts_nocheck=false \
			--go-starpc_out=$${OUT} \
			--es-starpc_out=$${OUT} \
			--es-starpc_opt target=ts \
			--es-starpc_opt ts_nocheck=false \
			--proto_path $${OUT} \
			--print_structure \
			--only_specified_files \
			$$(echo "$$PROTO_FILES" | xargs printf -- "./vendor/$${PROJECT}/%s "); \
		for proto_file in $${PROTO_FILES}; do \
			proto_dir=$$(dirname $$proto_file); \
			proto_name=$${proto_file%".proto"}; \
			TS_FILES=$$(git ls-files ":(glob)$${proto_dir}/${proto_name}*_pb.ts"); \
			if [ -z "$$TS_FILES" ]; then continue; fi; \
			for ts_file in $${TS_FILES}; do \
				prettier -w $$ts_file; \
				ts_file_dir=$$(dirname $$ts_file); \
				relative_path=$${ts_file_dir#"./"}; \
				depth=$$(echo $$relative_path | awk -F/ '{print NF+1}'); \
				prefix=$$(printf '../%0.s' $$(seq 1 $$depth)); \
				istmts=$$(grep -oE "from\s+\"$$prefix[^\"]+\"" $$ts_file) || continue; \
				if [ -z "$$istmts" ]; then continue; fi; \
				ipaths=$$(echo "$$istmts" | awk -F'"' '{print $$2}'); \
				for import_path in $$ipaths; do \
					rel_import_path=$$(realpath -s --relative-to=./vendor \
						"./vendor/$${PROJECT}/$${ts_file_dir}/$${import_path}"); \
					go_import_path=$$(echo $$rel_import_path | sed -e "s|^|@go/|"); \
					sed -i -e "s|$$import_path|$$go_import_path|g" $$ts_file; \
				done; \
			done; \
		done; \
	}; \
	protogen "./*.proto"; \
	rm -f ./vendor/$${PROJECT}
	$(GOIMPORTS) -w ./

.PHONY: gen
gen: genproto

.PHONY: outdated
outdated: $(GO_MOD_OUTDATED)
	go list -mod=mod -u -m -json all | $(GO_MOD_OUTDATED) -update -direct

.PHONY: list
list: $(GO_MOD_OUTDATED)
	go list -mod=mod -u -m -json all | $(GO_MOD_OUTDATED)

.PHONY: lint
lint: $(GOLANGCI_LINT)
	$(GOLANGCI_LINT) run

.PHONY: fix
fix: $(GOLANGCI_LINT)
	$(GOLANGCI_LINT) run --fix

.PHONY: test
test:
	go test -v ./...

.PHONY: format
format: $(GOFUMPT) $(GOIMPORTS)
	$(GOIMPORTS) -w ./
	$(GOFUMPT) -w ./

.PHONY: integration
integration: node_modules vendor
	cd ./integration && bash ./integration.bash
